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

app.get('/api/imgur-status', (req, res) => {
  const clientId = process.env.IMGUR_CLIENT_ID ? process.env.IMGUR_CLIENT_ID.trim() : '';
  res.json({
    configured: Boolean(clientId && clientId.length > 3),
    hasEnvKey: Boolean(clientId && clientId.length > 3)
  });
});

app.get('/api/imgur-key', (req, res) => {
  const clientId = process.env.IMGUR_CLIENT_ID ? process.env.IMGUR_CLIENT_ID.trim() : '';
  res.json({
    configured: Boolean(clientId && clientId.length > 3),
    clientId: clientId || null
  });
});

app.post('/api/upload-imgur', async (req, res) => {
  try {
    const envClientId = process.env.IMGUR_CLIENT_ID ? process.env.IMGUR_CLIENT_ID.trim() : '';
    const userClientId = req.body?.customClientId ? String(req.body.customClientId).trim() : '';
    const clientId = userClientId || envClientId;

    if (!clientId) {
      return res.status(400).json({
        success: false,
        needsKey: true,
        error: 'No Imgur Client ID found. Please enter your free Client ID from api.imgur.com/oauth2/addclient.'
      });
    }

    const { image, name, title, description } = req.body || {};
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
    formData.append('type', 'base64');
    if (title || name) {
      formData.append('title', title || name);
    }
    if (description) {
      formData.append('description', description);
    }

    let imgurResponse;
    try {
      imgurResponse = await fetch('https://api.imgur.com/3/image', {
        method: 'POST',
        headers: {
          'Authorization': `Client-ID ${clientId}`,
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        },
        body: formData,
      });
    } catch (netErr) {
      console.error('Network error contacting Imgur:', netErr);
      return res.json({
        success: false,
        fallbackClientUpload: true,
        clientKey: clientId,
        error: 'Direct server connection to Imgur timed out. Trying direct browser upload...'
      });
    }

    // Imgur blocks datacenter IPs with 429
    if (imgurResponse.status === 429) {
      console.log('Imgur rate-limited server IP (HTTP 429). Instructing browser to upload directly.');
      return res.json({
        success: false,
        fallbackClientUpload: true,
        clientKey: clientId,
        error: 'Imgur flagged cloud server IP. Completing upload directly from your browser...'
      });
    }

    const rawText = await imgurResponse.text();
    let data = null;
    try {
      data = JSON.parse(rawText);
    } catch {
      console.warn('Imgur returned non-JSON response:', rawText.slice(0, 200));
      return res.json({
        success: false,
        fallbackClientUpload: true,
        clientKey: clientId,
        error: 'Imgur firewall blocked server IP. Falling back to direct browser upload...'
      });
    }

    if (!imgurResponse.ok || !data?.success) {
      const errMsg = data?.data?.error || `Imgur upload failed (Status ${imgurResponse.status})`;
      return res.status(imgurResponse.status || 400).json({
        success: false,
        error: errMsg
      });
    }

    return res.json({
      success: true,
      url: data.data.link,
      display_url: data.data.link,
      delete_url: data.data.deletehash ? `https://imgur.com/delete/${data.data.deletehash}` : '',
      deletehash: data.data.deletehash,
      id: data.data.id,
      width: data.data.width,
      height: data.data.height
    });
  } catch (err) {
    console.error('Error in /api/upload-imgur:', err);
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
