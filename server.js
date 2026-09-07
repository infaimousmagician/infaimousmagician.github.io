import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '35mb' }));
app.use(express.static(__dirname));

app.post('/api/upload-imgbb', async (req, res) => {
  try {
    const apiKey = process.env.IMGBB_API_KEY;
    if (!apiKey) {
      return res.status(400).json({
        success: false,
        needsKey: true,
        error: 'ImgBB API key is missing. To upload directly to ImgBB, create a free account at imgbb.com, generate an API key at api.imgbb.com, and enter it into the app Settings under IMGBB_API_KEY.'
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

    const imgbbResponse = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      body: formData,
    });

    const data = await imgbbResponse.json();

    if (!imgbbResponse.ok || !data.success) {
      const errMsg = data?.error?.message || `ImgBB upload failed with status ${imgbbResponse.status}`;
      return res.status(imgbbResponse.status || 500).json({
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
    console.error('Error during ImgBB upload proxy:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Internal server error while uploading to ImgBB'
    });
  }
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
