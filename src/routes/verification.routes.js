import express from 'express';
import { protect, authorize } from '../middleware/auth.js';

const router = express.Router();

// Admin only routes
router.use(protect);
router.use(authorize('admin'));

router.get('/pending', (req, res) => {
  res.json({ message: 'Pending verifications - Coming soon' });
});

export default router;
