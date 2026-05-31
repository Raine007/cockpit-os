import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { db } from '../../lib/firebase';

const router = Router();
router.use(authMiddleware);

// GET /api/tasks?pillar=ig_content&status=active
router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const pillar = req.query.pillar as string;
    const status = req.query.status as string;
    let query: any = db.collection('tasks').orderBy('createdAt', 'desc').limit(limit);
    if (pillar) query = query.where('pillar', '==', pillar);
    if (status) query = query.where('status', '==', status);
    const snapshot = await query.get();
    const tasks = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ tasks, count: tasks.length });
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to fetch tasks', detail: e.message });
  }
});

// POST /api/tasks — create a new task
router.post('/', async (req: Request, res: Response) => {
  try {
    const { title, due, pillar } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    const doc = {
      title,
      due: due || '',
      status: 'active',
      pillar: pillar || 'cockpit_os',
      createdAt: new Date().toISOString(),
    };
    const ref = await db.collection('tasks').add(doc);
    res.status(201).json({ id: ref.id, ...doc });
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to create task', detail: e.message });
  }
});

// PUT /api/tasks/:id — update status, title, due
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { status, title, due } = req.body;
    const update: any = {};
    if (status) update.status = status;
    if (title) update.title = title;
    if (due !== undefined) update.due = due;

    await db.collection('tasks').doc(req.params.id).update(update);
    res.json({ id: req.params.id, ...update, updated: true });
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to update task', detail: e.message });
  }
});

// DELETE /api/tasks/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await db.collection('tasks').doc(req.params.id).delete();
    res.json({ id: req.params.id, deleted: true });
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to delete task', detail: e.message });
  }
});

export default router;
