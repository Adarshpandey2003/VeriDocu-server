import express from 'express';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.use(protect);

router.get('/requests', (req, res) => {
  res.json({ message: 'Consent requests - Coming soon' });
});

export default router;
