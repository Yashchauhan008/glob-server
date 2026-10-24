import { Router } from 'express';
import withDatabase from '@/shared/utilities/with-database.js';
import validate from '@/shared/middlewares/request-validator.js';

import {
    Controller as registerUser,
    ValidationSchema as registerUserValidationSchema,
} from '@/modules/auth/controllers/register-user.js';
import {
    Controller as verifyRegistration,
    ValidationSchema as verifyRegistrationValidationSchema,
} from '@/modules/auth/controllers/verify-registration.js';
import {
    Controller as loginUser,
    ValidationSchema as loginUserValidationSchema,
} from '@/modules/auth/controllers/login-user.js';

const router = Router();

router.route('/register').post(validate(registerUserValidationSchema), withDatabase(registerUser));

router
    .route('/verify-registration')
    .post(validate(verifyRegistrationValidationSchema), withDatabase(verifyRegistration));

router.route('/login').post(validate(loginUserValidationSchema), withDatabase(loginUser));

// Unmatched methods (including a browser GET) must end here. Otherwise they fall
// through to the global authenticate middleware and come back 401 with no CORS headers.
router.use((_req, res) => {
    res.status(404).json({ code: 'not_found', message: 'Not found' });
});

export default router;
