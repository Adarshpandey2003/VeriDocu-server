import express from 'express';

const router = express.Router();

router.get('/candidates', (req, res) => {
  res.json({ message: 'Search candidates - Coming soon' });
});

router.get('/companies', (req, res) => {
  res.json({ message: 'Search companies - Coming soon' });
});

export default router;
