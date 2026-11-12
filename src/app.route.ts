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
import attachmentRoutes from '@/modules/attachments/attachments.route.js';
import alertRoutes from '@/modules/alerts/alerts.route.js';
import activityRoutes, { activityLogger } from '@/modules/activity/activity.route.js';
import qaRoutes from '@/modules/qa/qa.route.js';
import voiceRoutes from '@/modules/voice/voice.route.js';
import teamRoutes from '@/modules/team/team.route.js';
import boardRoutes from '@/modules/boards/boards.route.js';
import teamsRoutes from '@/modules/teams/teams.route.js';
import { teamScope } from '@/modules/teams/team.scope.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/files', fileRoutes);

router.use(authenticate);
router.get('/me', (req, res) => res.json({ user: req.user }));
router.use('/teams', teamsRoutes); // which teams can I open? (the admin also creates them here)

// everything below belongs to one team, chosen with the X-Team-Id header
router.use(teamScope);
router.use(activityLogger);
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
router.use('/alerts', alertRoutes);
router.use('/attachments', attachmentRoutes);
router.use('/voice', voiceRoutes);
router.use('/team', teamRoutes);
router.use('/boards', boardRoutes);

export default router;
