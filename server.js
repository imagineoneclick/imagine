require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const Stripe  = require('stripe');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const axios   = require('axios');
const multer  = require('multer');
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

const PACKS = {
  starter:  { credits: 5,  amount: 499,  label: '5 images' },
  standard: { credits: 20, amount: 1499, label: '20 images' },
  pro:      { credits: 50, amount: 2999, label: '50 images' },
};

const usedJtis = new Set();

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
  const { pack } = req.body;
  const packData = PACKS[pack];
  if (!packData) return res.status(400).json({ error: 'Invalid pack.' });
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8080';
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price_data: { currency: 'usd', unit_amount: packData.amount, product_data: { name: `Imagine · ${packData.label}`, description: `${packData.credits} AI image generations` } }, quantity: 1 }],
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

async function uploadToCloudinary(buffer, mimetype) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'imagine-refs', resource_type: 'image' },
      (error, result) => {
        if (error) reject(error);
        else resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

app.post('/generate', upload.any(), async (req, res) => {
  let payload;
  try { payload = verifyAndConsume(req.headers.authorization); }
  catch (err) { return res.status(401).json({ error: err.message }); }

  const prompt = req.body?.prompt || '';
  const ratio  = req.body?.ratio  || '1:1';

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

  try {
    let refImageUrls = [];
    if (req.files && req.files.length > 0) {
      const uploads = req.files.map(f => uploadToCloudinary(f.buffer, f.mimetype));
      refImageUrls = await Promise.all(uploads);
    }

    // Use image-edit model if reference images provided, otherwise text-to-image
    let endpoint, requestBody;

    if (refImageUrls.length > 0) {
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
      if (status === 'failed') throw new Error('Generation failed on WaveSpeed');
    }

    if (!imageUrl) throw new Error('Image generation timed out');

    const newCredits = payload.credits - 1;
    const { token: newToken } = issueToken(newCredits);
    res.json({ imageUrl, newToken, credits: newCredits });

  } catch (err) {
    console.error('Generation error:', err.message);
    usedJtis.delete(payload.jti);
    res.status(500).json({ error: 'Image generation failed: ' + err.message });
  }
});

app.get('/dev-credits', (req, res) => {
  const { token } = issueToken(10);
  res.json({ token, credits: 10 });
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
  };
  const selected = packages[pack];
  if (!selected) return res.status(400).json({ error: 'Invalid pack.' });

  try {
    const response = await axios.post(
      'https://api.nowpayments.io/v1/payment',
      {
        price_amount: selected.amount,
        price_currency: 'usd',
        pay_currency: 'btc',
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
    res.json({ paymentUrl: `https://nowpayments.io/payment/?iid=${response.data.payment_id}`, paymentId: response.data.payment_id });
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