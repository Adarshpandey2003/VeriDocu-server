// Debug routes were removed. This module intentionally exports an empty router
// to keep imports stable for deployments that may still reference it.
import express from 'express';

const router = express.Router();

router.use((req, res) => {
  res.status(404).json({ success: false, message: 'Not found' });
});

export default router;
