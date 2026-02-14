# PostgreSQL Migration Plan

## Tasks to Complete

### Phase 1: Backend Setup
- [ ] 1. Update package.json to add PostgreSQL dependencies (pg, uuid)
- [ ] 2. Create database config file (config/database.js)
- [ ] 3. Create PostgreSQL schema with proper indexes (database/schema.sql)
- [ ] 4. Create database connection pool (db/index.js)
- [ ] 5. Create session logging model (models/sessionLog.js)
- [ ] 6. Create user model (models/user.js)
- [ ] 7. Create chat session model (models/chatSession.js)
- [ ] 8. Create message model (models/message.js)
- [ ] 9. Create attachment model (models/attachment.js)
- [ ] 10. Create authentication controller with refresh tokens (controllers/authController.js)
- [ ] 11. Create middleware for auth (middleware/auth.js)
- [ ] 12. Create refresh token middleware (middleware/refreshToken.js)
- [ ] 13. Update index.js to use PostgreSQL

### Phase 2: Frontend Updates
- [ ] 14. Update App.jsx to handle refresh tokens
- [ ] 15. Add axios interceptor for token refresh

### Phase 3: Testing
- [ ] 16. Test authentication flow
- [ ] 17. Test session persistence
- [ ] 18. Test refresh token flow
- [ ] 19. Verify session logging works
