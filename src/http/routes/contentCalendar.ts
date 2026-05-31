import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { db } from '../../lib/firebase';

const router = Router();
router.use(authMiddleware);

// GET /api/content-calendar?status=scheduled&limit=20
router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const status = req.query.status as string;
    let query: any = db.collection('content_calendar').orderBy('scheduledDate', 'asc').limit(limit);
    if (status) query = query.where('status', '==', status);
    const snapshot = await query.get();
    const items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ items, count: items.length });
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to fetch calendar', detail: e.message });
  }
});

// POST /api/content-calendar — schedule a new content item
router.post('/', async (req: Request, res: Response) => {
  try {
    const { title, platform, scheduledDate, caption, hashtags, videoUrl, song } = req.body;
    if (!title || !scheduledDate) return res.status(400).json({ error: 'title and scheduledDate are required' });
    const doc = {
      title,
      platform: platform || 'instagram',
      scheduledDate,
      status: 'draft',
      caption: caption || '',
      hashtags: hashtags || '',
      videoUrl: videoUrl || '',
      song: song || '',
      createdAt: new Date().toISOString(),
    };
    const ref = await db.collection('content_calendar').add(doc);
    res.status(201).json({ id: ref.id, ...doc });
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to schedule content', detail: e.message });
  }
});

// PUT /api/content-calendar/:id — update status, caption, etc.
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { status, caption, scheduledDate } = req.body;
    const update: any = {};
    if (status) update.status = status;
    if (caption) update.caption = caption;
    if (scheduledDate) update.scheduledDate = scheduledDate;

    await db.collection('content_calendar').doc(req.params.id).update(update);
    res.json({ id: req.params.id, ...update, updated: true });
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to update calendar item', detail: e.message });
  }
});

export default router;