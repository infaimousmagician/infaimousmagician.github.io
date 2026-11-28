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

// Postimages server-side proxy helpers (strict HTTPS host allowlist to prevent SSRF)
const POSTIMAGES_ALLOWED_HOSTS = new Set([
  'postimg.cc',
  'www.postimg.cc',
  'i.postimg.cc',
  'postimages.org',
  'www.postimages.org',
  'i.postimages.org',
  'postimage.org',
  'www.postimage.org'
]);

const POSTIMAGES_ALLOWED_TYPES = new Set(['png', 'gif', 'jpg', 'jpeg', 'webp']);

const POSTIMAGES_BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function isAllowedPostimagesUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return POSTIMAGES_ALLOWED_HOSTS.has(host);
  } catch {
    return false;
  }
}

function decodeBasicXmlEntities(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function extractXmlTag(xml, tagName) {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = xml.match(regex);
  if (!match) return '';
  const raw = match[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim();
  return decodeBasicXmlEntities(raw);
}

async function fetchAllowlistedPostimagesPage(urlString, maxRedirects = 2) {
  let currentUrl = urlString;
  for (let i = 0; i <= maxRedirects; i++) {
    if (!isAllowedPostimagesUrl(currentUrl)) {
      throw new Error('Blocked disallowed Postimages redirect host.');
    }
    const resp = await fetch(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': POSTIMAGES_BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      signal: AbortSignal.timeout(12000)
    });
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      if (!location) break;
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (!resp.ok) {
      throw new Error(`Viewer page returned status ${resp.status}`);
    }
    return await resp.text();
  }
  throw new Error('Too many redirects resolving Postimages link.');
}

async function resolvePostimagesDirectLink(viewerUrl) {
  if (!isAllowedPostimagesUrl(viewerUrl)) return null;
  try {
    const html = await fetchAllowlistedPostimagesPage(viewerUrl);
    // 1. Official "Direct link" input box on Postimages viewer page
    const directInputMatch =
      html.match(/<input[^>]*id=["']code_direct["'][^>]*value=["']([^"']+)["']/i) ||
      html.match(/<input[^>]*value=["']([^"']+)["'][^>]*id=["']code_direct["']/i);
    if (directInputMatch && isAllowedPostimagesUrl(directInputMatch[1])) {
      return decodeBasicXmlEntities(directInputMatch[1]);
    }
    // 2. OpenGraph og:image meta tag
    const ogMatch =
      html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
    if (ogMatch && isAllowedPostimagesUrl(ogMatch[1])) {
      return decodeBasicXmlEntities(ogMatch[1]);
    }
    // 3. Direct CDN image URL in page markup
    const cdnMatch = html.match(/https:\/\/i\.postimg\.cc\/[A-Za-z0-9_-]+\/[^"'\s<>]+\.(?:png|gif|jpe?g|webp)/i);
    if (cdnMatch && isAllowedPostimagesUrl(cdnMatch[0])) {
      return decodeBasicXmlEntities(cdnMatch[0]);
    }
    return null;
  } catch (err) {
    console.warn('Could not resolve direct Postimages hotlink from viewer page:', err.message);
    return null;
  }
}

async function uploadToPostimagesWithApiKey({ apiKey, base64Data, safeName, safeType }) {
  const params = new URLSearchParams();
  params.set('key', apiKey);
  params.set('o', '2b819584285c102318568238c7d4a4c7');
  params.set('m', '59c4f0a8025c0b5808b22b3e302a8d2c');
  params.set('version', '1.0.1');
  params.set('portable', '1');
  params.set('name', safeName);
  params.set('type', safeType);
  params.set('image', base64Data);

  const response = await fetch('https://api.postimage.org/1/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': POSTIMAGES_BROWSER_UA,
      'Accept': 'application/xml, text/xml, */*'
    },
    body: params.toString(),
    signal: AbortSignal.timeout(25000)
  });

  const rawText = await response.text();
  const isSuccess = /<data[^>]*\bsuccess=["']1["']/i.test(rawText);
  const errorText = extractXmlTag(rawText, 'error') || extractXmlTag(rawText, 'message');

  if (!response.ok || !isSuccess) {
    return {
      ok: false,
      status: response.status,
      error: errorText || `Postimages API returned status ${response.status}`
    };
  }

  let hotlink = extractXmlTag(rawText, 'hotlink');
  const pageUrl = extractXmlTag(rawText, 'page');
  const thumbUrl = extractXmlTag(rawText, 'thumbnail');
  const deleteUrl = extractXmlTag(rawText, 'delete');

  if (!isAllowedPostimagesUrl(hotlink) && isAllowedPostimagesUrl(pageUrl)) {
    const resolved = await resolvePostimagesDirectLink(pageUrl);
    if (resolved) hotlink = resolved;
  }

  const finalUrl = isAllowedPostimagesUrl(hotlink)
    ? hotlink
    : (isAllowedPostimagesUrl(pageUrl) ? pageUrl : '');

  if (!finalUrl) {
    return { ok: false, status: 502, error: 'Postimages did not return a valid image URL.' };
  }

  return {
    ok: true,
    url: finalUrl,
    display_url: finalUrl,
    thumb_url: isAllowedPostimagesUrl(thumbUrl) ? thumbUrl : finalUrl,
    viewer_url: isAllowedPostimagesUrl(pageUrl) ? pageUrl : finalUrl,
    delete_url: isAllowedPostimagesUrl(deleteUrl) ? deleteUrl : '',
    mode: 'api_key'
  };
}

function generateUploadSessionId() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

async function uploadToPostimagesAnonymous({ base64Data, safeName, safeType }) {
  // Step 1: Fetch Postimages homepage to get a valid web upload token and session cookie
  const homeResp = await fetch('https://postimages.org/', {
    method: 'GET',
    headers: {
      'User-Agent': POSTIMAGES_BROWSER_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!homeResp.ok) {
    return { ok: false, status: homeResp.status, error: `Could not reach Postimages (Status ${homeResp.status}).` };
  }

  const homeHtml = await homeResp.text();
  const tokenMatch =
    homeHtml.match(/["']token["']\s*[,:]\s*["']([a-zA-Z0-9_-]{8,128})["']/i) ||
    homeHtml.match(/name=["']token["'][^>]*value=["']([a-zA-Z0-9_-]{8,128})["']/i);
  const token = tokenMatch ? tokenMatch[1] : '';

  const setCookieHeaders = typeof homeResp.headers.getSetCookie === 'function'
    ? homeResp.headers.getSetCookie()
    : (homeResp.headers.get('set-cookie') ? [homeResp.headers.get('set-cookie')] : []);
  const cookieHeader = setCookieHeaders
    .map(c => String(c).split(';')[0].trim())
    .filter(Boolean)
    .join('; ');

  const mimeMap = {
    png: 'image/png',
    gif: 'image/gif',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp'
  };
  const mimeType = mimeMap[safeType] || 'image/png';
  const binaryBuffer = Buffer.from(base64Data, 'base64');
  const blob = new Blob([binaryBuffer], { type: mimeType });

  const formData = new FormData();
  if (token) formData.append('token', token);
  formData.append('upload_session', generateUploadSessionId());
  formData.append('numfiles', '1');
  formData.append('gallery', '');
  formData.append('ui', '1920__1080__true__?__?__' + new Date().toISOString());
  formData.append('optsize', '0');
  formData.append('expire', '0');
  formData.append('session_upload', String(Date.now()));
  formData.append('file', blob, `${safeName}.${safeType}`);

  const uploadHeaders = {
    'User-Agent': POSTIMAGES_BROWSER_UA,
    'Origin': 'https://postimages.org',
    'Referer': 'https://postimages.org/',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest'
  };
  if (cookieHeader) {
    uploadHeaders['Cookie'] = cookieHeader;
  }

  const uploadResp = await fetch('https://postimages.org/json/rr', {
    method: 'POST',
    headers: uploadHeaders,
    body: formData,
    signal: AbortSignal.timeout(25000)
  });

  const rawText = await uploadResp.text();
  let json = null;
  try {
    json = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      status: uploadResp.status || 502,
      error: 'Postimages returned an unexpected response (possibly rate-limited or protected).'
    };
  }

  if (!uploadResp.ok || !json || (json.status !== 'OK' && !json.url)) {
    return {
      ok: false,
      status: uploadResp.status || 400,
      error: json?.error || 'Postimages anonymous upload was rejected.'
    };
  }

  const viewerUrl = isAllowedPostimagesUrl(json.url) ? json.url : '';
  if (!viewerUrl) {
    return { ok: false, status: 502, error: 'Postimages did not return a valid viewer link.' };
  }

  const directUrl = await resolvePostimagesDirectLink(viewerUrl);
  const finalUrl = directUrl && isAllowedPostimagesUrl(directUrl) ? directUrl : viewerUrl;

  return {
    ok: true,
    url: finalUrl,
    display_url: finalUrl,
    thumb_url: finalUrl,
    viewer_url: viewerUrl,
    delete_url: '',
    mode: 'anonymous'
  };
}

app.get('/api/postimages-status', (req, res) => {
  const apiKey = process.env.POSTIMAGES_API_KEY ? process.env.POSTIMAGES_API_KEY.trim() : '';
  res.json({
    configured: Boolean(apiKey && apiKey.length > 5),
    hasEnvKey: Boolean(apiKey && apiKey.length > 5),
    anonymousFallbackAvailable: true
  });
});

app.post('/api/upload-postimages', async (req, res) => {
  try {
    const envApiKey = process.env.POSTIMAGES_API_KEY ? process.env.POSTIMAGES_API_KEY.trim() : '';
    const { image, name, type } = req.body || {};

    if (typeof image !== 'string' || !image.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Missing image data for upload.'
      });
    }

    const dataUriMatch = image.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,/);
    const detectedExt = dataUriMatch ? dataUriMatch[1].toLowerCase().replace('jpeg', 'jpg') : '';
    const requestedType = typeof type === 'string' ? type.trim().toLowerCase() : '';
    const candidateType = requestedType || detectedExt || 'png';
    const safeType = POSTIMAGES_ALLOWED_TYPES.has(candidateType) ? candidateType : 'png';

    const base64Data = image.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '').replace(/\s+/g, '');
    if (!base64Data || !/^[A-Za-z0-9+/=]+$/.test(base64Data)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid base64 image payload.'
      });
    }

    // Limit decoded upload size to ~30MB
    if (base64Data.length > 42 * 1024 * 1024) {
      return res.status(413).json({
        success: false,
        error: 'Image is too large for Postimages upload. Try reducing dimensions.'
      });
    }

    const rawName = typeof name === 'string' ? name.trim() : '';
    const safeName = rawName.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'gta-rp-chatlog';

    let result = null;
    let primaryError = '';

    // 1. If server POSTIMAGES_API_KEY is configured, use the authenticated Postimages API endpoint first
    if (envApiKey) {
      try {
        result = await uploadToPostimagesWithApiKey({
          apiKey: envApiKey,
          base64Data,
          safeName,
          safeType
        });
        if (!result.ok) {
          primaryError = result.error || '';
        }
      } catch (err) {
        console.warn('Postimages API key upload failed, trying fallback:', err.message);
        primaryError = err.message || 'Postimages API request failed.';
      }
    }

    // 2. Fallback to Postimages server-side anonymous web upload if no key is configured or API endpoint errored
    if (!result || !result.ok) {
      try {
        const anonResult = await uploadToPostimagesAnonymous({
          base64Data,
          safeName,
          safeType
        });
        if (anonResult.ok) {
          result = anonResult;
        } else if (!primaryError) {
          primaryError = anonResult.error || 'Postimages upload failed.';
        }
      } catch (err) {
        console.warn('Postimages anonymous upload error:', err.message);
        if (!primaryError) {
          primaryError = err.message || 'Could not contact Postimages.';
        }
      }
    }

    if (!result || !result.ok) {
      return res.status(502).json({
        success: false,
        error: primaryError || 'Postimages upload failed. Try configuring POSTIMAGES_API_KEY in app secrets or switch to ImgBB in Settings.'
      });
    }

    return res.json({
      success: true,
      provider: 'postimages',
      url: result.url,
      display_url: result.display_url,
      thumb_url: result.thumb_url,
      viewer_url: result.viewer_url,
      delete_url: result.delete_url,
      mode: result.mode
    });
  } catch (err) {
    console.error('Error in /api/upload-postimages:', err);
    return res.status(500).json({
      success: false,
      error: 'An internal error occurred while uploading to Postimages.'
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
