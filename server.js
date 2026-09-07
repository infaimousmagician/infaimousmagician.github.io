import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname));

app.get('/api/imgbb-status', (req, res) => {
  const apiKey = process.env.IMGBB_API_KEY ? process.env.IMGBB_API_KEY.trim() : '';
  res.json({
    configured: Boolean(apiKey && apiKey.length > 5),
    hasEnvKey: Boolean(apiKey && apiKey.length > 5)
  });
});

app.get('/api/imgbb-key', (req, res) => {
  const apiKey = process.env.IMGBB_API_KEY ? process.env.IMGBB_API_KEY.trim() : '';
  res.json({
    configured: Boolean(apiKey && apiKey.length > 5),
    apiKey: apiKey || null
  });
});

app.post('/api/upload-imgbb', async (req, res) => {
  try {
    const envApiKey = process.env.IMGBB_API_KEY ? process.env.IMGBB_API_KEY.trim() : '';
    const userApiKey = req.body?.customApiKey ? String(req.body.customApiKey).trim() : '';
    const apiKey = userApiKey || envApiKey;

    if (!apiKey) {
      return res.status(400).json({
        success: false,
        needsKey: true,
        error: 'No ImgBB API key found. Please enter your free key from api.imgbb.com.'
      });
    }

    const { image, name } = req.body || {};
    if (!image) {
      return res.status(400).json({
        success: false,
        error: 'Missing image data for upload.'
      });
    }

    // Strip data URL prefix if present
    const base64Data = image.replace(/^data:image\/[a-z]+;base64,/, '');

    const formData = new FormData();
    formData.append('image', base64Data);
    if (name) {
      formData.append('name', name);
    }

    let imgbbResponse;
    try {
      imgbbResponse = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        },
        body: formData,
      });
    } catch (netErr) {
      console.error('Network error contacting ImgBB:', netErr);
      return res.json({
        success: false,
        fallbackClientUpload: true,
        clientKey: apiKey,
        error: 'Direct server connection to ImgBB timed out. Trying direct browser upload...'
      });
    }

    const rawText = await imgbbResponse.text();
    let data = null;
    try {
      data = JSON.parse(rawText);
    } catch {
      console.warn('ImgBB returned non-JSON response (likely Cloudflare or HTML block):', rawText.slice(0, 200));
      // Cloudflare or HTML block on datacenter IP: signal client to upload directly from browser
      return res.json({
        success: false,
        fallbackClientUpload: true,
        clientKey: apiKey,
        error: 'ImgBB cloud firewall blocked server IP. Falling back to direct browser upload...'
      });
    }

    // If ImgBB returned code 103 (datacenter IP block)
    if (data?.error?.code === 103 || (data?.error?.message && data.error.message.includes('forbidden to use this website'))) {
      console.log('ImgBB blocked cloud runner IP (code 103). Instructing client to upload directly.');
      return res.json({
        success: false,
        fallbackClientUpload: true,
        clientKey: apiKey,
        error: 'ImgBB flagged cloud server IP. Completing upload directly from your browser...'
      });
    }

    if (!imgbbResponse.ok || !data?.success) {
      const errMsg = data?.error?.message || `ImgBB upload failed (Status ${imgbbResponse.status})`;
      return res.status(imgbbResponse.status || 400).json({
        success: false,
        error: errMsg
      });
    }

    return res.json({
      success: true,
      url: data.data.url,
      display_url: data.data.display_url,
      viewer_url: data.data.url_viewer,
      delete_url: data.data.delete_url,
      width: data.data.width,
      height: data.data.height
    });
  } catch (err) {
    console.error('Error in /api/upload-imgbb:', err);
    return res.status(500).json({
      success: false,
      error: 'An internal error occurred while processing the upload.'
    });
  }
});

// Express error handler for payload-too-large or parser errors
app.use((err, req, res, next) => {
  if (err) {
    console.error('Express middleware error:', err.message);
    return res.status(err.status || 500).json({
      success: false,
      error: err.type === 'entity.too.large'
        ? 'Screenshot image is too large to send to server. Try reducing dimensions.'
        : err.message || 'Server request error.'
    });
  }
  next();
});

app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'clover.png'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
