// Module augmentation for Express's Request — adds the `accountId` field
// populated by the withAccountId middleware in routes/accounts.ts.
import 'express';

declare global {
  namespace Express {
    interface Request {
      accountId?: string;
    }
  }
}
