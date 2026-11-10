require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const Stripe  = require('stripe');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const axios   = require('axios');
const multer  = require('multer');
const { referenceDuration } = require('./video-duration');
const { v2: cloudinary } = require('cloudinary');

const app    = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const upload = multer({ storage: multer.memoryStorage() });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

app.use(cors({ 
  origin: [
    'https://imagineoneclick.com',
    'https://www.imagineoneclick.com',
    'https://sage-hummingbird-722846.netlify.app'
  ] 
}));
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// Priced in USD because the customers are American. This account settles in
// MXN, so Stripe converts each charge at payout — that's supported and needs
// no extra setup. (Side effect: Adaptive Pricing stays dormant, since it only
// runs when the price currency is also a settlement currency.)
const PACKS = {
  starter:  { credits: 5,  amount: 499,  label: '5 credits' },
  standard: { credits: 20, amount: 1499, label: '20 credits' },
  pro:      { credits: 50, amount: 2999, label: '50 credits' },
  value:    { credits: 100, amount: 4999, label: '100 credits' },
};

const usedJtis = new Set();

function generationError(source) {
  const data = source?.response?.data || source;
  const detail = data?.data || data;
  const message = [detail?.error, detail?.message, data?.message, source?.message]
    .map(value => typeof value === 'string' ? value : value?.message || '').join(' ');
  const flagged = source?.errorCode === 'CONTENT_FLAGGED' ||
    [detail?.code, data?.code, detail?.error?.code].some(code => String(code) === '1200') ||
    /potentially sensitive|content.{0,30}(?:flagged|moderation|safety|policy)|nsfw|safety.{0,20}(?:check|filter|block)/i.test(message);
  const error = new Error(flagged
    ? 'This generation was blocked by the content safety check. Please try a different reference image or video.'
    : 'Generation could not be completed. Please try again later.');
  error.errorCode = flagged ? 'CONTENT_FLAGGED' : 'GENERATION_FAILED';
  return error;
}

function issueToken(credits) {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ credits, jti }, process.env.JWT_SECRET, { expiresIn: '365d' });
  return { token, credits };
}

function verifyAndConsume(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('No token provided.');
  const raw = authHeader.slice(7);
  let payload;
  try { payload = jwt.verify(raw, process.env.JWT_SECRET); }
  catch { throw new Error('Invalid or expired token.'); }
  if (usedJtis.has(payload.jti)) throw new Error('Token already used.');
  if (payload.credits < 1) throw new Error('No credits remaining.');
  usedJtis.add(payload.jti);
  return payload;
}

app.get('/credits', (req, res) => {
  try {
    if (!req.headers.authorization?.startsWith('Bearer ')) return res.json({ credits: 0 });
    const payload = jwt.verify(req.headers.authorization.slice(7), process.env.JWT_SECRET);
    res.json({ credits: payload.credits });
  } catch { res.json({ credits: 0 }); }
});

app.post('/create-checkout', async (req, res) => {
  // Temporary purchase-only pause. Remove this guard after the owner tops up.
  return res.status(503).json({
    error: 'Credit purchases are temporarily paused. We expect to reopen within 24 hours.',
    code: 'PURCHASES_PAUSED'
  });
  const { pack } = req.body;
  const packData = PACKS[pack];
  if (!packData) return res.status(400).json({ error: 'Invalid pack.' });
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8080';
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price_data: { currency: 'usd', unit_amount: packData.amount, product_data: { name: `Imagine · ${packData.label}`, description: `${packData.credits} credits for images and video` } }, quantity: 1 }],
      mode: 'payment',
      success_url: `${frontendUrl}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/`,
      metadata: { pack, credits: String(packData.credits) },
    });
    res.json({ sessionId: session.id });
  } catch (err) {
    res.status(500).json({ error: 'Could not create checkout session.' });
  }
});

app.get('/confirm-purchase', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id.' });
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') return res.status(402).json({ error: 'Payment not completed.' });
    const credits = parseInt(session.metadata.credits, 10);
    const { token } = issueToken(credits);
    res.json({ token, credits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Uploads straight to WaveSpeed's own storage using the key we already have.
// Two steps: ask for a signed URL, then PUT the bytes to it. Max 200 MiB,
// files kept 7 days — plenty, since references only need to outlive the job.
// (Cloudinary is no longer used for this. Its config above is left in place
// in case you want it back; delete it whenever you like.)
async function uploadToWaveSpeed(buffer, filename, contentType) {
  const init = await axios.post(
    'https://api.wavespeed.ai/api/v3/media/uploads',
    { filename: filename || 'upload.bin', size: buffer.length, content_type: contentType },
    { headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.WAVESPEED_API_KEY}`,
    } }
  );

  const data = init.data?.data;
  const put = data?.upload;
  if (!put?.url || !data?.download_url) throw new Error('Could not start upload to WaveSpeed');

  await axios.put(put.url, buffer, {
    headers: put.headers || { 'Content-Type': contentType },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  return data.download_url;
}

// The browser keeps this random receipt until it has saved the result.
const imageJobs = new Map();
app.get('/image-job/:id', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const job = imageJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Image job not found.' });
  try {
    const owner = jwt.verify((req.headers.authorization || '').slice(7), process.env.JWT_SECRET);
    if (owner.jti !== job.owner) throw new Error();
  } catch {
    return res.status(403).json({ error: 'This receipt belongs to another balance.' });
  }
  return res.json(job.result);
});

app.post('/generate', upload.any(), async (req, res) => {
  const headshot = req.body?.preset === 'studio-headshot';
  if (headshot && (req.files?.length !== 1 || !req.files[0].mimetype.startsWith('image/'))) {
    return res.status(400).json({ error: 'Add one photo to create your reference image.' });
  }

  const receipt = headshot && req.body?.receipt;
  if (receipt && !/^[0-9a-f-]{36}$/i.test(receipt)) {
    return res.status(400).json({ error: 'Invalid image receipt.' });
  }
  if (receipt && imageJobs.has(receipt)) {
    return res.status(409).json({ error: 'Image request already submitted.' });
  }
  let payload;
  try { payload = verifyAndConsume(req.headers.authorization); }
  catch (err) { return res.status(401).json({ error: err.message }); }

  const prompt = headshot ? 'Photorealistic close-up portrait of the reference image, looking directly at the camera with a calm neutral expression, soft natural makeup, bare shoulders and upper chest, soft even studio lighting, plain light gray seamless background, high detail skin texture, sharp focus on the eyes, professional beauty photography, 85mm lens, shallow depth of field' : req.body?.prompt || '';
  const ratio = headshot ? '3:4' : req.body?.ratio || '1:1';

  if (!prompt || prompt.trim().length < 1) {
    usedJtis.delete(payload.jti);
    return res.status(400).json({ error: 'Please enter a prompt.' });
  }

  const sizeMap = {
    '1:1':  '1024*1024',
    '16:9': '1280*720',
    '9:16': '720*1280',
    '4:3':  '1024*768',
    '3:4':  '768*1024',
    '3:2':  '1216*832',
    '2:3':  '832*1216',
  };
  const size = sizeMap[ratio] ?? '1024*1024';

  const job = receipt ? { owner: payload.jti, result: { status: 'processing' } } : null;
  if (job) {
    imageJobs.set(receipt, job);
    res.status(202).json(job.result);
    setTimeout(() => imageJobs.delete(receipt), 24 * 60 * 60 * 1000).unref();
  }
  try {
    let refImageUrls = [];
    if (req.files && req.files.length > 0) {
      const uploads = req.files.map(f => uploadToWaveSpeed(f.buffer, f.originalname, f.mimetype));
      refImageUrls = await Promise.all(uploads);
    }

    // Use image-edit model if reference images provided, otherwise text-to-image
    let endpoint, requestBody;

    if (headshot) {
      endpoint = 'https://api.wavespeed.ai/api/v3/google/nano-banana-pro/edit';
      requestBody = {
        prompt,
        images: refImageUrls,
        aspect_ratio: ratio,
        resolution: '1k',
        output_format: 'png',
      };
    } else if (refImageUrls.length > 0) {
      endpoint = 'https://api.wavespeed.ai/api/v3/alibaba/wan-2.7/image-edit';
      requestBody = {
        prompt: prompt.trim().slice(0, 800),
        images: refImageUrls.slice(0, 3),
        size: size,
        seed: -1,
      };
    } else {
      endpoint = 'https://api.wavespeed.ai/api/v3/alibaba/wan-2.7/text-to-image';
      requestBody = {
        prompt: prompt.trim().slice(0, 800),
        size: size,
        seed: -1,
      };
    }

    const submitRes = await axios.post(endpoint, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.WAVESPEED_API_KEY}`,
      },
    });

    const predictionId = submitRes.data?.data?.id;
    if (!predictionId) throw new Error('No prediction ID returned');

    let imageUrl = null;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const pollRes = await axios.get(
        `https://api.wavespeed.ai/api/v3/predictions/${predictionId}/result`,
        { headers: { 'Authorization': `Bearer ${process.env.WAVESPEED_API_KEY}` } }
      );
      const status = pollRes.data?.data?.status;
      if (status === 'completed') {
        imageUrl = pollRes.data?.data?.outputs?.[0];
        break;
      }
      if (['failed', 'cancelled', 'timeout', 'deleted'].includes(status)) throw generationError(pollRes.data);
    }

    if (!imageUrl) throw new Error('Image generation timed out');

    const newCredits = payload.credits - 1;
    const { token: newToken } = issueToken(newCredits);
    const result = { imageUrl, newToken, credits: newCredits };
    if (job) job.result = { status: 'completed', ...result };
    else res.json(result);

  } catch (err) {
    console.error('Generation error:', err.message);
    usedJtis.delete(payload.jti);
    const failure = generationError(err);
    // Image credits are deducted only on success; release the original token.
    const result = { status: 'failed', error: failure.message, errorCode: failure.errorCode,
      creditsRestored: true, credits: payload.credits };
    if (job) job.result = result;
    else res.status(500).json(result);
  }
});

// ============================================================
// VIDEO — Wan 3.0 reference-to-video
// Async: the HTTP request returns a jobId immediately and the
// poll runs in the background, because Wan takes 1–4 minutes
// and Railway will cut a request held open that long.
//
// PROTOTYPE: videoJobs lives in memory and is lost on redeploy.
// Move it to Postgres before launch.
// ============================================================

const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 20 },
});

const VIDEO_CREDITS_PER_SECOND = { '480p': 0.5, '720p': 1, '1080p': 2 };
const videoJobs = new Map();

function videoCost(resolution, duration) {
  return Math.ceil(duration * (VIDEO_CREDITS_PER_SECOND[resolution] || 1));
}

function verifyAndConsumeFor(authHeader, cost) {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('No token provided.');
  let payload;
  try { payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET); }
  catch { throw new Error('Invalid or expired token.'); }
  if (usedJtis.has(payload.jti)) throw new Error('Token already used.');
  if (payload.credits < cost) throw new Error(`Not enough credits — this costs ${cost}.`);
  usedJtis.add(payload.jti);
  return payload;
}


function failVideoJob(jobId, failure) {
  const job = videoJobs.get(jobId);
  if (!job || job.status === 'completed' || job.status === 'failed') return;
  const error = generationError(failure);
  console.error(`Video job ${jobId} failed:`, error.message);
  job.status = 'failed';
  job.error = error.message;
  job.errorCode = error.errorCode;
  // Refund: burn the deducted token, mint one with the credits put back.
  usedJtis.add(job.newJti);
  job.refundToken = issueToken(job.creditsAfter + job.cost).token;
  job.creditsRestored = true;
}

async function runVideoJob(jobId, files) {
  const job = videoJobs.get(jobId);
  if (!job) return;

  job.status = 'uploading';
  const ofKind = (prefix) => files.filter(f => f.fieldname.startsWith(prefix));

  const send = (f) => uploadToWaveSpeed(f.buffer, f.originalname, f.mimetype);
  const [images, videos, audios] = await Promise.all([
    Promise.all(ofKind('img_').map(send)),
    Promise.all(ofKind('vid_').map(send)),
    Promise.all(ofKind('aud_').map(send)),
  ]);
  console.log(`Video job ${job.id} uploaded ${images.length} img / ${videos.length} vid / ${audios.length} aud`);

  const body = {
    prompt: job.prompt.slice(0, 800),
    resolution: job.resolution,
    aspect_ratio: job.aspect,
    duration: job.duration,
    enable_audio: true,
    enable_prompt_expansion: true,
  };
  if (images.length) body.reference_images = images.slice(0, 10);
  if (videos.length) body.reference_videos = videos.slice(0, 5);
  if (audios.length) body.reference_audios = audios.slice(0, 5);

  const submitRes = await axios.post(
    'https://api.wavespeed.ai/api/v3/alibaba/wan-3.0/reference-to-video',
    body,
    { headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.WAVESPEED_API_KEY}`,
    } }
  );

  const predictionId = submitRes.data?.data?.id;
  if (!predictionId) throw new Error('No prediction ID returned');

  job.status = 'processing';
  job.predictionId = predictionId;
  console.log(`Video job ${job.id} submitted · prediction ${predictionId} · ${job.duration}s ${job.resolution}`);

  const MAX_POLLS = 400;                    // ~20 minutes at 3s
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, 3000));

    let pollRes;
    try {
      pollRes = await axios.get(
        `https://api.wavespeed.ai/api/v3/predictions/${predictionId}/result`,
        { headers: { 'Authorization': `Bearer ${process.env.WAVESPEED_API_KEY}` } }
      );
    } catch (err) {
      if (generationError(err).errorCode === 'CONTENT_FLAGGED') throw generationError(err);
      // A blip while polling shouldn't throw away a generation we've paid for.
      console.warn(`Video job ${job.id} poll error at ${i * 3}s: ${err.message}`);
      continue;
    }

    const status = pollRes.data?.data?.status;
    if (i % 10 === 0) console.log(`Video job ${job.id} · ${status} · ${i * 3}s elapsed`);

    if (status === 'completed') {
      job.videoUrl = pollRes.data?.data?.outputs?.[0];
      if (!job.videoUrl) throw new Error('Completed with no output URL');
      job.status = 'completed';
      console.log(`Video job ${job.id} completed in ${i * 3}s`);
      return;
    }
    if (['failed', 'cancelled', 'timeout', 'deleted'].includes(status)) {
      throw generationError(pollRes.data);
    }
  }
  throw new Error(`Still generating after 20 minutes. Recover it with prediction ${predictionId}`);
}

app.post('/video-quote', videoUpload.single('video'), async (req, res) => {
  try {
    const measured = await referenceDuration(req.file);
    res.json({ ...measured, costs: Object.fromEntries(
      Object.keys(VIDEO_CREDITS_PER_SECOND).map(q => [q, videoCost(q, measured.duration)])
    ) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/generate-video', videoUpload.any(), async (req, res) => {
  const usePreset = req.body?.preset === 'reference-swap';
  if (usePreset) {
    const files = req.files || [];
    if (files.length !== 2 || !files.some(f => f.fieldname === 'img_0' && f.mimetype.startsWith('image/')) ||
        !files.some(f => f.fieldname === 'vid_0' && f.mimetype.startsWith('video/'))) {
      return res.status(400).json({ error: 'Add one image and one video to generate.' });
    }
  }
  const prompt = usePreset ? `Replace the woman in Video 1 with the exact woman from Image 1.
Image 1 is the sole and complete source of identity:
- Face, facial features, skin tone, and style
- Hair (style, length, color, texture)
- Body shape, proportions, height, build, and physical details

Strictly preserve from Video 1 with zero changes:
- Every motion, gesture, pose, expressions and action frame-by-frame
- Camera movement, framing, and angles
- Outfit, clothing details, and accessories
- Lighting, shadows, and color grading
- Background, environment, and all other elements
Maintain perfect temporal consistency across the entire video. No identity drift, no morphing, no artifacts. The final result must look like the original Video 1 performance, but performed by the woman from Image 1.` : (req.body?.prompt || '').trim();
  const aspect     = req.body?.aspect_ratio || '16:9';
  const resolution = ['480p', '720p', '1080p'].includes(req.body?.resolution) ? req.body.resolution : '720p';

  // Measure the uploaded file; client-supplied seconds never determine billing.
  const videoFiles = (req.files || []).filter(f => f.fieldname.startsWith('vid_'));
  if (videoFiles.length !== 1) return res.status(400).json({ error: 'Add exactly one reference video.' });
  let duration;
  try { ({ duration } = await referenceDuration(videoFiles[0])); }
  catch (error) { return res.status(400).json({ error: error.message }); }

  const cost = videoCost(resolution, duration);
  if (Number(req.body?.duration) !== duration || Number(req.body?.expected_cost) !== cost) {
    return res.status(409).json({ error: 'Video length or cost changed. Refresh the page and add your reference again.', duration, cost });
  }

  let payload;
  try { payload = verifyAndConsumeFor(req.headers.authorization, cost); }
  catch (err) { return res.status(401).json({ error: err.message }); }

  if (!prompt) {
    usedJtis.delete(payload.jti);
    return res.status(400).json({ error: 'Please enter a prompt.' });
  }
  if (!req.files?.length) {
    usedJtis.delete(payload.jti);
    return res.status(400).json({ error: 'Add at least one reference.' });
  }

  const creditsAfter = payload.credits - cost;
  const { token: newToken } = issueToken(creditsAfter);

  const jobId = crypto.randomUUID();
  videoJobs.set(jobId, {
    id: jobId, status: 'created', prompt, duration, aspect, resolution,
    cost, creditsAfter, newJti: jwt.decode(newToken).jti,
    videoUrl: null, error: null, refundToken: null, createdAt: Date.now(),
  });

  // Hand the client its jobId and deducted token now; work continues after.
  res.json({ jobId, newToken, credits: creditsAfter, cost });

  runVideoJob(jobId, req.files).catch(err => failVideoJob(jobId, err));
});

app.get('/video-job/:id', (req, res) => {
  const job = videoJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json({
    id: job.id,
    status: job.status,
    videoUrl: job.videoUrl,
    error: job.error,
    errorCode: job.errorCode || null,
    creditsRestored: job.creditsRestored === true,
    predictionId: job.predictionId || null,
    refundToken: job.refundToken,
    credits: job.status === 'failed' ? job.creditsAfter + job.cost : job.creditsAfter,
  });
});

// Rescue a generation that finished on WaveSpeed after we stopped waiting —
// or one lost to a redeploy. Get the prediction ID from your WaveSpeed
// dashboard (or the Railway log) and call this with your DEV_CREDITS_KEY.
app.get('/video-recover', async (req, res) => {
  const key = process.env.DEV_CREDITS_KEY;
  if (!key || req.query.key !== key) {
    return res.status(404).send('Cannot GET /video-recover');
  }
  const id = req.query.prediction_id;
  if (!id) return res.status(400).json({ error: 'Pass prediction_id.' });

  try {
    const r = await axios.get(
      `https://api.wavespeed.ai/api/v3/predictions/${id}/result`,
      { headers: { 'Authorization': `Bearer ${process.env.WAVESPEED_API_KEY}` } }
    );
    res.json({
      status: r.data?.data?.status,
      outputs: r.data?.data?.outputs || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// Drop finished jobs after an hour so the Map doesn't grow forever.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of videoJobs) {
    if (job.createdAt < cutoff) videoJobs.delete(id);
  }
}, 10 * 60 * 1000);

// Credit faucet for testing. Requires DEV_CREDITS_KEY to be set in Railway
// AND matched in the query string — without both, this 404s like any unknown
// route, so it's closed by default. Delete the env var to shut it off entirely.
app.get('/dev-credits', (req, res) => {
  const key = process.env.DEV_CREDITS_KEY;
  if (!key || req.query.key !== key) {
    return res.status(404).send('Cannot GET /dev-credits');
  }
  const amount = Math.min(Math.max(parseInt(req.query.amount, 10) || 10, 1), 200);
  const { token } = issueToken(amount);
  res.json({ token, credits: amount });
});

app.post('/webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET); }
  catch (err) { return res.status(400).send(`Webhook Error: ${err.message}`); }
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    console.log(`Payment confirmed · ${s.metadata.credits} credits`);
  }
  res.json({ received: true });
});
// Create NOWPayments crypto payment
app.post('/create-crypto-payment', async (req, res) => {
  const { pack } = req.body;
  const packages = {
    starter:  { credits: 5,  amount: 4.99,  name: '5 Credits' },
    standard: { credits: 20, amount: 14.99, name: '20 Credits' },
    pro:      { credits: 50, amount: 29.99, name: '50 Credits' },
    value:    { credits: 100, amount: 49.99, name: '100 Credits' },
  };
  const selected = packages[pack];
  if (!selected) return res.status(400).json({ error: 'Invalid pack.' });

  try {
    const response = await axios.post(
      'https://api.nowpayments.io/v1/invoice',
      {
        price_amount: selected.amount,
        price_currency: 'usd',
        order_id: `${pack}-${Date.now()}`,
order_description: `Imagine - ${selected.name}`,
ipn_callback_url: `https://imagine-production-5857.up.railway.app/crypto-webhook`,
success_url: `https://imagineoneclick.com/?crypto_pack=${pack}`,
cancel_url: `https://imagineoneclick.com/`,
      },
      {
        headers: {
          'x-api-key': process.env.NOWPAYMENTS_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );
    res.json({ paymentUrl: response.data.invoice_url, paymentId: response.data.id });
  } catch (err) {
    console.error('NOWPayments error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Could not create crypto payment.' });
  }
});

// NOWPayments webhook
app.post('/crypto-webhook', async (req, res) => {
  const { payment_status, order_id } = req.body;
  if (payment_status === 'finished' || payment_status === 'confirmed') {
    console.log(`Crypto payment confirmed: ${order_id}`);
  }
  res.status(200).send('OK');
});

// Verify crypto payment and issue credits
app.get('/verify-crypto', async (req, res) => {
  const { payment_id, pack } = req.query;
  const packages = {
    starter:  { credits: 5  },
    standard: { credits: 20 },
    pro:      { credits: 50 },
    value:    { credits: 100 },
  };
  const selected = packages[pack];
  if (!selected || !payment_id) return res.status(400).json({ error: 'Invalid request.' });

  try {
    const response = await axios.get(
      `https://api.nowpayments.io/v1/payment/${payment_id}`,
      { headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY } }
    );
    const status = response.data.payment_status;
    if (status === 'finished' || status === 'confirmed' || status === 'sending') {
      const { token } = issueToken(selected.credits);
      res.json({ token, credits: selected.credits });
    } else {
      res.status(402).json({ error: 'Payment not confirmed yet. Status: ' + status });
    }
  } catch (err) {
    res.status(500).json({ error: 'Could not verify payment.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`imagine-backend running on port ${PORT}`));
