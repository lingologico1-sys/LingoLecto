const express = require('express');
const path = require('path');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Agent } = require('undici');

// Custom undici agent with extended timeouts for long-running API calls (OpenAI can take 5+ minutes)
const longTimeoutAgent = new Agent({
    headersTimeout: 600000,   // 10 minutes
    bodyTimeout: 600000,
    connectTimeout: 30000
});

const app = express();
// JSON body parser — skip for /api/upload-image (raw binary)
app.use((req, res, next) => {
    if (req.path === '/api/upload-image') return next();
    express.json({ limit: '50mb' })(req, res, next);
});
app.use(express.static(path.join(__dirname, 'public')));

// ── Environment variables ────────────────────────────────────────────────
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const R2_ACCESS_KEY_ID = (process.env.R2_ACCESS_KEY_ID || '').trim();
const R2_SECRET_ACCESS_KEY = (process.env.R2_SECRET_ACCESS_KEY || '').trim();
const R2_ACCOUNT_ID = (process.env.R2_ACCOUNT_ID || '').trim();
const LECTO_BUCKET = 'lecto';
const LECTO_DOMAIN = 'https://lecto.lingomondo.app';
const APP_PASSWORD = process.env.APP_PASSWORD || 'lingologico';

// ── Auth middleware (protects creation/generation endpoints) ─────────────
function requireAuth(req, res, next) {
    const token = req.headers['x-auth-token'];
    if (token === APP_PASSWORD) return next();
    res.status(401).json({ error: 'Unauthorized — invalid or missing password' });
}

// ── R2 Client ────────────────────────────────────────────────────────────
function makeR2Client() {
    if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ACCOUNT_ID) {
        console.error('R2 credentials missing:', {
            hasAccessKey: !!R2_ACCESS_KEY_ID,
            hasSecretKey: !!R2_SECRET_ACCESS_KEY,
            hasAccountId: !!R2_ACCOUNT_ID
        });
        return null;
    }
    return new S3Client({
        region: 'auto',
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: R2_ACCESS_KEY_ID,
            secretAccessKey: R2_SECRET_ACCESS_KEY
        },
        forcePathStyle: true
    });
}

// ── R2 Image Upload: server-side proxy (avoids browser CORS on presigned URLs) ──
app.post('/api/upload-image', requireAuth, async (req, res) => {
    try {
        // Read raw body manually (no body-parser middleware)
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);

        console.log('Upload request received:', body.length, 'bytes');

        if (!body.length) {
            return res.status(400).json({ ok: false, error: 'Empty file body received' });
        }

        const fileName = req.headers['x-filename'] || 'image.jpg';
        const fileType = (req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();

        const s3 = makeR2Client();
        if (!s3) return res.status(500).json({ ok: false, error: 'R2 credentials not configured' });

        const cleanName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
        const key = `img/${Date.now()}_${cleanName}`;

        await s3.send(new PutObjectCommand({
            Bucket: LECTO_BUCKET,
            Key: key,
            ContentType: fileType,
            Body: body
        }));

        const publicUrl = `${LECTO_DOMAIN}/${key}`;

        console.log('Upload success:', publicUrl);
        res.json({ ok: true, publicUrl });
    } catch (err) {
        console.error('Image upload error:', err);
        res.status(500).json({ ok: false, error: err.message || 'Upload failed' });
    }
});

// ── R2 Image Upload: get pre-signed URL ──────────────────────────────────
app.post('/api/upload-url', requireAuth, async (req, res) => {
    try {
        const { fileName, fileType } = req.body;

        if (!fileName || !fileType) {
            return res.status(400).json({ ok: false, error: 'fileName and fileType are required' });
        }

        const s3 = makeR2Client();
        if (!s3) {
            return res.status(500).json({ ok: false, error: 'R2 credentials not configured' });
        }

        const cleanName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
        const key = `img/${Date.now()}_${cleanName}`;

        const command = new PutObjectCommand({
            Bucket: LECTO_BUCKET,
            Key: key,
            ContentType: fileType
        });

        const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });

        const publicUrl = `${LECTO_DOMAIN}/${key}`;

        res.json({ ok: true, uploadUrl, publicUrl });

    } catch (err) {
        console.error('Upload URL error:', err);
        res.status(500).json({ ok: false, error: err.message || 'Failed to generate upload URL' });
    }
});

// ── OpenAI: chunk French text via stored prompt (async polling) ──────────
const chunkJobs = new Map();

app.post('/api/chunk', requireAuth, (req, res) => {
    const { sourceText } = req.body;

    if (!sourceText || !sourceText.trim()) {
        return res.status(400).json({ error: 'sourceText is required' });
    }
    if (!OPENAI_API_KEY) {
        return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
    }

    const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    chunkJobs.set(jobId, { status: 'processing', startedAt: Date.now() });

    // Fire off OpenAI in the background
    (async () => {
        try {
            const apiResponse = await fetch('https://api.openai.com/v1/responses', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + OPENAI_API_KEY
                },
                signal: AbortSignal.timeout(600000),
                dispatcher: longTimeoutAgent,
                body: JSON.stringify({
                    model: 'gpt-5.4',
                    prompt: {
                        id: 'pmpt_69b2d7a72cb881969e6ae694840f10bb00fedaf3be2cf1ea',
                        version: '11',
                        variables: { source_text: sourceText }
                    }
                })
            });

            if (!apiResponse.ok) {
                const errText = await apiResponse.text();
                chunkJobs.set(jobId, { status: 'error', error: `OpenAI API Error: ${apiResponse.status} - ${errText}` });
                return;
            }

            const data = await apiResponse.json();

            let outputText = '';
            if (data.output) {
                for (const item of data.output) {
                    if (item.type === 'message' && item.content) {
                        for (const block of item.content) {
                            if (block.type === 'output_text') {
                                outputText += block.text;
                            }
                        }
                    }
                }
            }

            if (!outputText) {
                chunkJobs.set(jobId, { status: 'error', error: 'No text output received from OpenAI' });
                return;
            }

            let cleaned = outputText.trim();
            if (cleaned.startsWith('```')) {
                cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
            }

            let readerJson;
            try {
                readerJson = JSON.parse(cleaned);
            } catch (e) {
                chunkJobs.set(jobId, { status: 'error', error: 'OpenAI returned invalid JSON: ' + e.message, raw: outputText.substring(0, 500) });
                return;
            }

            const usage = data.usage || null;
            chunkJobs.set(jobId, { status: 'done', result: readerJson, usage });
        } catch (err) {
            console.error('Chunk error:', err);
            const cause = err.cause ? ` (${err.cause.code || err.cause.message || ''})` : '';
            chunkJobs.set(jobId, { status: 'error', error: (err.message || 'Internal server error') + cause });
        }

        // Clean up job after 5 minutes
        setTimeout(() => chunkJobs.delete(jobId), 300000);
    })();

    // Return immediately with the job ID
    res.json({ jobId });
});

app.get('/api/chunk/:jobId', (req, res) => {
    const job = chunkJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (job.status === 'processing') {
        return res.json({ status: 'processing', elapsed: Date.now() - job.startedAt });
    }
    if (job.status === 'error') {
        chunkJobs.delete(req.params.jobId);
        return res.status(500).json({ status: 'error', error: job.error, raw: job.raw });
    }
    // done
    const result = job.result;
    const usage = job.usage || null;
    chunkJobs.delete(req.params.jobId);
    res.json({ status: 'done', result, usage });
});

// ── Publish: upload audio + images + consolidated JSON to lecto bucket ──
app.post('/api/publish', requireAuth, async (req, res) => {
    try {
        const { title, readerData, tiptapData, alignmentData, audioBase64 } = req.body;

        if (!title) return res.status(400).json({ ok: false, error: 'title is required' });
        if (!readerData) return res.status(400).json({ ok: false, error: 'readerData is required' });
        if (!audioBase64) return res.status(400).json({ ok: false, error: 'audioBase64 is required' });

        const s3 = makeR2Client();
        if (!s3) return res.status(500).json({ ok: false, error: 'R2 credentials not configured' });

        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

        // 1. Upload audio
        const audioBuf = Buffer.from(audioBase64, 'base64');
        const audioKey = `aud/${slug}.mp3`;
        await s3.send(new PutObjectCommand({
            Bucket: LECTO_BUCKET,
            Key: audioKey,
            ContentType: 'audio/mpeg',
            Body: audioBuf
        }));
        const audioUrl = `${LECTO_DOMAIN}/${audioKey}`;
        console.log('Published audio:', audioUrl);

        // 2. Migrate images from old domain → lecto bucket, rewrite URLs in tiptap HTML
        let processedHtml = (tiptapData && tiptapData.html) || '';
        const oldImageRegex = /https:\/\/image\.lingomondo\.app\/(cdn-cgi\/image\/[^/]+\/)?(lingoscribo\/[^"'\s)]+)/g;
        const matches = [...processedHtml.matchAll(oldImageRegex)];
        for (const match of matches) {
            const fullUrl = match[0];
            const originalKey = match[2]; // e.g. lingoscribo/12345_file.jpg
            const filename = originalKey.replace('lingoscribo/', '');
            const newKey = `img/${filename}`;
            try {
                const imgRes = await fetch(fullUrl);
                if (imgRes.ok) {
                    const imgBuf = Buffer.from(await imgRes.arrayBuffer());
                    const ct = imgRes.headers.get('content-type') || 'image/jpeg';
                    await s3.send(new PutObjectCommand({
                        Bucket: LECTO_BUCKET,
                        Key: newKey,
                        ContentType: ct,
                        Body: imgBuf
                    }));
                    processedHtml = processedHtml.split(fullUrl).join(`${LECTO_DOMAIN}/${newKey}`);
                    console.log('Migrated image:', fullUrl, '→', `${LECTO_DOMAIN}/${newKey}`);
                }
            } catch (imgErr) {
                console.error('Image migration failed for', fullUrl, imgErr.message);
            }
        }

        // 3. Build consolidated JSON
        const consolidated = {
            title,
            slug,
            source_language: readerData.source_language,
            chunks: readerData.chunks,
            tiptap_html: processedHtml,
            alignment: alignmentData || null,
            audio_url: audioUrl
        };

        // 4. Upload JSON
        const jsonKey = `json/${slug}.json`;
        await s3.send(new PutObjectCommand({
            Bucket: LECTO_BUCKET,
            Key: jsonKey,
            ContentType: 'application/json',
            Body: JSON.stringify(consolidated)
        }));
        const jsonUrl = `${LECTO_DOMAIN}/${jsonKey}`;
        console.log('Published JSON:', jsonUrl);

        res.json({ ok: true, jsonUrl, audioUrl });
    } catch (err) {
        console.error('Publish error:', err);
        res.status(500).json({ ok: false, error: err.message || 'Publish failed' });
    }
});

// ── List published lectos ────────────────────────────────────────────────
app.get('/api/lectos', async (req, res) => {
    try {
        const s3 = makeR2Client();
        if (!s3) return res.status(500).json({ ok: false, error: 'R2 credentials not configured' });

        const listRes = await s3.send(new ListObjectsV2Command({
            Bucket: LECTO_BUCKET,
            Prefix: 'json/'
        }));

        const items = [];
        for (const obj of (listRes.Contents || [])) {
            if (!obj.Key.endsWith('.json')) continue;
            const slug = obj.Key.replace('json/', '').replace('.json', '');
            // Fetch the JSON to get the title
            try {
                const getRes = await s3.send(new GetObjectCommand({ Bucket: LECTO_BUCKET, Key: obj.Key }));
                const body = await getRes.Body.transformToString();
                const data = JSON.parse(body);
                items.push({
                    slug,
                    title: data.title || slug,
                    date: obj.LastModified ? obj.LastModified.toISOString() : null,
                    jsonUrl: `${LECTO_DOMAIN}/${obj.Key}`,
                    audioUrl: data.audio_url || null
                });
            } catch (e) {
                items.push({ slug, title: slug, date: obj.LastModified ? obj.LastModified.toISOString() : null, jsonUrl: `${LECTO_DOMAIN}/${obj.Key}`, audioUrl: null });
            }
        }

        // Sort chronologically (newest first)
        items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        res.json({ ok: true, lectos: items });
    } catch (err) {
        console.error('List lectos error:', err);
        res.status(500).json({ ok: false, error: err.message || 'Failed to list lectos' });
    }
});

// ── Get a single lecto JSON ──────────────────────────────────────────────
app.get('/api/lectos/:slug', async (req, res) => {
    try {
        const { slug } = req.params;
        const s3 = makeR2Client();
        if (!s3) return res.status(500).json({ ok: false, error: 'R2 credentials not configured' });

        const getRes = await s3.send(new GetObjectCommand({ Bucket: LECTO_BUCKET, Key: `json/${slug}.json` }));
        const body = await getRes.Body.transformToString();
        res.json(JSON.parse(body));
    } catch (err) {
        console.error('Get lecto error:', err);
        res.status(404).json({ ok: false, error: err.message || 'Lecto not found' });
    }
});

// ── Stream lecto audio (with range request support for seeking) ─────────
app.get('/api/lectos/:slug/audio', async (req, res) => {
    try {
        const { slug } = req.params;
        const s3 = makeR2Client();
        if (!s3) return res.status(500).send('R2 credentials not configured');

        const key = `aud/${slug}.mp3`;
        const rangeHeader = req.headers.range;

        if (rangeHeader) {
            // Partial content (range request for seeking)
            const getRes = await s3.send(new GetObjectCommand({ Bucket: LECTO_BUCKET, Key: key, Range: rangeHeader }));
            res.status(206);
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Accept-Ranges', 'bytes');
            if (getRes.ContentRange) res.setHeader('Content-Range', getRes.ContentRange);
            if (getRes.ContentLength) res.setHeader('Content-Length', getRes.ContentLength);
            getRes.Body.pipe(res);
        } else {
            // Full content
            const getRes = await s3.send(new GetObjectCommand({ Bucket: LECTO_BUCKET, Key: key }));
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Accept-Ranges', 'bytes');
            if (getRes.ContentLength) res.setHeader('Content-Length', getRes.ContentLength);
            getRes.Body.pipe(res);
        }
    } catch (err) {
        console.error('Get audio error:', err);
        res.status(404).send('Audio not found');
    }
});

// ── Delete a lecto and all associated files ─────────────────────────────
app.delete('/api/lectos/:slug', requireAuth, async (req, res) => {
    try {
        const { slug } = req.params;
        const s3 = makeR2Client();
        if (!s3) return res.status(500).json({ ok: false, error: 'R2 credentials not configured' });

        const jsonKey = `json/${slug}.json`;

        // Read the JSON to find associated files
        let imageKeys = [];
        try {
            const getRes = await s3.send(new GetObjectCommand({ Bucket: LECTO_BUCKET, Key: jsonKey }));
            const body = await getRes.Body.transformToString();
            const data = JSON.parse(body);

            // Extract image URLs from tiptap_html
            if (data.tiptap_html) {
                const imgRegex = new RegExp(`${LECTO_DOMAIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(img/[^"'\\s)]+)`, 'g');
                let match;
                while ((match = imgRegex.exec(data.tiptap_html)) !== null) {
                    imageKeys.push(match[1]);
                }
            }
        } catch (e) {
            console.warn('Could not read lecto JSON for cleanup:', e.message);
        }

        // Delete all associated files
        const keysToDelete = [
            jsonKey,
            `aud/${slug}.mp3`,
            ...imageKeys
        ];

        for (const key of keysToDelete) {
            try {
                await s3.send(new DeleteObjectCommand({ Bucket: LECTO_BUCKET, Key: key }));
                console.log('Deleted:', key);
            } catch (e) {
                console.warn('Failed to delete:', key, e.message);
            }
        }

        res.json({ ok: true, deleted: keysToDelete });
    } catch (err) {
        console.error('Delete lecto error:', err);
        res.status(500).json({ ok: false, error: err.message || 'Delete failed' });
    }
});

// ── ElevenLabs: generate audio with timestamps ──────────────────────────
app.post('/api/generate', requireAuth, async (req, res) => {
    try {
        const { voiceId, text, stability, similarity_boost, style, use_speaker_boost } = req.body;

        if (!voiceId || !text) {
            return res.status(400).json({ error: 'voiceId and text are required' });
        }

        if (!ELEVEN_API_KEY) {
            return res.status(500).json({ error: 'ELEVEN_API_KEY not set' });
        }

        const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`;

        const apiResponse = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'xi-api-key': ELEVEN_API_KEY
            },
            body: JSON.stringify({
                text,
                model_id: 'eleven_v3',
                voice_settings: {
                    stability: stability ?? 0.5,
                    similarity_boost: similarity_boost ?? 0.75,
                    style: style ?? 0.0,
                    use_speaker_boost: use_speaker_boost !== false
                }
            })
        });

        if (!apiResponse.ok) {
            const errText = await apiResponse.text();
            return res.status(apiResponse.status).json({
                error: `ElevenLabs API Error: ${apiResponse.status} - ${errText}`
            });
        }

        const data = await apiResponse.json();
        res.json(data);

    } catch (err) {
        console.error('Generate error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    if (!ELEVEN_API_KEY) console.warn('⚠️  ELEVEN_API_KEY is not set!');
    if (!OPENAI_API_KEY) console.warn('⚠️  OPENAI_API_KEY is not set!');
    if (!R2_ACCESS_KEY_ID) console.warn('⚠️  R2_ACCESS_KEY_ID is not set!');
    else console.log('R2 config: account=' + R2_ACCOUNT_ID.slice(0,4) + '..., key=' + R2_ACCESS_KEY_ID.slice(0,4) + '..., secret=' + R2_SECRET_ACCESS_KEY.slice(0,4) + '...');
});
