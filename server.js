const express = require('express');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Environment variables ────────────────────────────────────────────────
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const IMAGE_BUCKET_NAME = 'img';
const IMAGE_DOMAIN = 'https://image.lingologico.com';

// ── R2 Client ────────────────────────────────────────────────────────────
function makeR2Client() {
    if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ACCOUNT_ID) {
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

// ── R2 Image Upload: get pre-signed URL ──────────────────────────────────
app.post('/api/upload-url', async (req, res) => {
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
        const key = `lingoscribo/${Date.now()}_${cleanName}`;

        const command = new PutObjectCommand({
            Bucket: IMAGE_BUCKET_NAME,
            Key: key,
            ContentType: fileType
        });

        const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });

        const optimizedFormats = ['image/avif', 'image/webp', 'image/svg+xml', 'image/gif'];
        const publicUrl = optimizedFormats.includes(fileType)
            ? `${IMAGE_DOMAIN}/${key}`
            : `${IMAGE_DOMAIN}/cdn-cgi/image/format=auto/${key}`;

        res.json({ ok: true, uploadUrl, publicUrl });

    } catch (err) {
        console.error('Upload URL error:', err);
        res.status(500).json({ ok: false, error: err.message || 'Failed to generate upload URL' });
    }
});

// ── OpenAI: chunk French text via stored prompt ──────────────────────────
app.post('/api/chunk', async (req, res) => {
    try {
        const { sourceText } = req.body;

        if (!sourceText || !sourceText.trim()) {
            return res.status(400).json({ error: 'sourceText is required' });
        }

        if (!OPENAI_API_KEY) {
            return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
        }

const apiResponse = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + OPENAI_API_KEY
            },
            signal: AbortSignal.timeout(180000),
            body: JSON.stringify({
                model: 'gpt-5.4',
                prompt: {
                    id: 'pmpt_69b2d7a72cb881969e6ae694840f10bb00fedaf3be2cf1ea',
                    version: '7',
                    variables: {
                        source_text: sourceText
                    }
                }
            })
        });

        if (!apiResponse.ok) {
            const errText = await apiResponse.text();
            return res.status(apiResponse.status).json({
                error: `OpenAI API Error: ${apiResponse.status} - ${errText}`
            });
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
            return res.status(500).json({ error: 'No text output received from OpenAI' });
        }

        let cleaned = outputText.trim();
        if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
        }

        let readerJson;
        try {
            readerJson = JSON.parse(cleaned);
        } catch (e) {
            return res.status(500).json({
                error: 'OpenAI returned invalid JSON: ' + e.message,
                raw: outputText.substring(0, 500)
            });
        }

        res.json(readerJson);

    } catch (err) {
        console.error('Chunk error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

// ── ElevenLabs: generate audio with timestamps ──────────────────────────
app.post('/api/generate', async (req, res) => {
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
});
