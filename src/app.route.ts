import { Router } from 'express';
import authRoutes from '@/modules/auth/auth.route.js';
import fileRoutes from '@/modules/file/file.route.js';

import authenticate from '@/shared/middlewares/authenticate.js';
import ideaRoutes from '@/modules/ideas/ideas.route.js';
import productRoutes from '@/modules/products/products.route.js';
import todoRoutes from '@/modules/todos/todos.route.js';
import leadRoutes from '@/modules/leads/leads.route.js';
import dashboardRoutes from '@/modules/dashboard/dashboard.route.js';
import csvRoutes from '@/modules/csv/csv.route.js';

import eventRoutes from '@/modules/events/events.route.js';
import chatRoutes from '@/modules/chat/chat.route.js';
import activityRoutes, { activityLogger } from '@/modules/activity/activity.route.js';
import qaRoutes from '@/modules/qa/qa.route.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/files', fileRoutes);

router.use(authenticate);
router.use(activityLogger);
router.get('/me', (req, res) => res.json({ user: req.user }));
router.use('/ideas', ideaRoutes);
router.use('/products', productRoutes);
router.use('/todos', todoRoutes);
router.use('/leads', leadRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/csv', csvRoutes);
router.use('/events', eventRoutes);
router.use('/chat', chatRoutes);
router.use('/questions', qaRoutes);
router.use('/activity', activityRoutes);

export default router;
