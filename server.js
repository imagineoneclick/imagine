require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const Stripe   = require('stripe');
const { fal }  = require('@fal-ai/client');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');

const app    = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

fal.config({ credentials: process.env.FAL_API_KEY });

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
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
  const token = jwt.sign(
    { credits, jti },
    process.env.JWT_SECRET,
    { expiresIn: '365d' }
  );
  return { token, credits };
}

function verifyAndConsume(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('No token provided.');
  const raw = authHeader.slice(7);
  let payload;
  try {
    payload = jwt.verify(raw, process.env.JWT_SECRET);
  } catch {
    throw new Error('Invalid or expired token.');
  }
  if (usedJtis.has(payload.jti)) throw new Error('Token already used.');
  if (payload.credits < 1) throw new Error('No credits remaining.');
  usedJtis.add(payload.jti);
  return payload;
}

app.get('/credits', (req, res) => {
  try {
    if (!req.headers.authorization?.startsWith('Bearer ')) {
      return res.json({ credits: 0 });
    }
    const raw = req.headers.authorization.slice(7);
    const payload = jwt.verify(raw, process.env.JWT_SECRET);
    res.json({ credits: payload.credits });
  } catch {
    res.json({ credits: 0 });
  }
});

app.post('/create-checkout', async (req, res) => {
  const { pack } = req.body;
  const packData = PACKS[pack];
  if (!packData) return res.status(400).json({ error: 'Invalid pack.' });

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8080';

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: packData.amount,
          product_data: {
            name: `Imagine · ${packData.label}`,
            description: `${packData.credits} AI image generations · Powered by fal.ai`,
          },
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${frontendUrl}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${frontendUrl}/`,
      metadata: { pack, credits: String(packData.credits) },
    });

    res.json({ sessionId: session.id });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: 'Could not create checkout session.' });
  }
});

app.get('/confirm-purchase', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id.' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Payment not completed.' });
    }

    const credits = parseInt(session.metadata.credits, 10);
    const { token } = issueToken(credits);

    res.json({ token, credits });
  } catch (err) {
    console.error('Confirm error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/generate', async (req, res) => {
  let payload;
  try {
    payload = verifyAndConsume(req.headers.authorization);
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }

  const { prompt, ratio } = req.body;

  if (!prompt || prompt.trim().length < 1) {
    usedJtis.delete(payload.jti);
    return res.status(400).json({ error: 'Please enter a prompt.' });
  }

  const dimensionMap = {
    '1:1':  { width: 1024, height: 1024 },
    '16:9': { width: 1280, height: 720  },
    '9:16': { width: 720,  height: 1280 },
    '4:3':  { width: 1024, height: 768  },
    '3:4':  { width: 768,  height: 1024 },
    '3:2':  { width: 1216, height: 832  },
    '2:3':  { width: 832,  height: 1216 },
  };
  const dims = dimensionMap[ratio] ?? dimensionMap['1:1'];

  try {
    const result = await fal.subscribe('fal-ai/flux/schnell', {
      input: {
        prompt: prompt.trim().slice(0, 800),
        image_size: {
          width: dims.width,
          height: dims.height,
        },
        num_inference_steps: 4,
        num_images: 1,
        enable_safety_checker: true,
      },
      logs: false,
    });

    const imageUrl = result?.images?.[0]?.url ?? result?.data?.images?.[0]?.url;
    if (!imageUrl) throw new Error('No image returned from fal.ai');

    const newCredits = payload.credits - 1;
    const { token: newToken } = issueToken(newCredits);

    res.json({ imageUrl, newToken, credits: newCredits });

  } catch (err) {
    console.error('Generation error:', err.message);
    usedJtis.delete(payload.jti);
    res.status(500).json({ error: 'Image generation failed: ' + err.message });
  }
});

app.post('/webhook', (req, res) => {
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    console.log(`Payment confirmed · pack: ${s.metadata.pack} · ${s.metadata.credits} credits`);
  }
  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`imagine-backend running on port ${PORT}`));