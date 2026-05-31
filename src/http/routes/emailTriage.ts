import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { db } from '../../lib/firebase';

const router = Router();
router.use(authMiddleware);

// GET /api/email-triage?limit=20&status=new
router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const status = req.query.status as string;
    let query: any = db.collection('email_triage').orderBy('createdAt', 'desc').limit(limit);
    if (status) query = query.where('status', '==', status);
    const snapshot = await query.get();
    const emails = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ emails, count: emails.length });
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to fetch emails', detail: e.message });
  }
});

// POST /api/email-triage — submit an email for triage
router.post('/', async (req: Request, res: Response) => {
  try {
    const { from, subject, body } = req.body;
    if (!from || !subject) return res.status(400).json({ error: 'from and subject are required' });

    const doc = {
      from, subject, body: body || '',
      priority: 'medium',
      intent: '',
      status: 'new',
      createdAt: new Date().toISOString(),
    };

    const ref = await db.collection('email_triage').add(doc);
    res.status(201).json({ id: ref.id, ...doc });
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to create email triage entry', detail: e.message });
  }
});

// PUT /api/email-triage/:id — update status, priority, intent
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { status, priority, intent } = req.body;
    const update: any = {};
    if (status) update.status = status;
    if (priority) update.priority = priority;
    if (intent !== undefined) update.intent = intent;

    await db.collection('email_triage').doc(req.params.id).update(update);
    res.json({ id: req.params.id, ...update, updated: true });
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to update email', detail: e.message });
  }
});

export default router;
