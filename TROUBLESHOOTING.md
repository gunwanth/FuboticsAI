# Troubleshooting, Errors, Testing, and Version Control Guide

This document serves as a centralized place to track common errors, their solutions, troubleshooting techniques, testing procedures, and version control practices for the Fubotics AI Chat project.

## Common Errors and Solutions

### OpenAI API Key Issues
- **Error:** "Invalid API key" or "Authentication failed"
- **Solution:** Ensure your `.env` file contains a valid `OPENAI_API_KEY`. Check that the key is not expired and has sufficient credits. If using a restricted key, ensure the API endpoints are allowed.

### Database Connection Errors
- **Error:** "SQLite database error" or "Cannot open database file"
- **Solution:** Verify that the database file exists in the backend directory. Check file permissions and ensure the path is correct. If the file is corrupted, delete it and restart the server to recreate.

### Frontend Build Errors
- **Error:** "Module not found" or dependency issues
- **Solution:** Run `npm install` in the frontend directory. Clear node_modules and reinstall if necessary. Check for version conflicts in package.json.

### Port Already in Use
- **Error:** "EADDRINUSE" when starting the server
- **Solution:** Change the port in the backend configuration or kill the process using the port. On Windows, use `netstat -ano | findstr :5000` to find the PID and `taskkill /PID <PID> /F` to kill it.

### CORS Errors
- **Error:** "CORS policy: No 'Access-Control-Allow-Origin' header"
- **Solution:** Ensure the backend has CORS middleware enabled. Check the Express server configuration for cors settings.

### Chat Session Not Loading
- **Error:** Messages not displaying or sessions not persisting
- **Solution:** Check the SQLite database for data integrity. Verify API endpoints are responding correctly. Clear browser cache and try again.

### OpenAI Rate Limit Exceeded
- **Error:** "Rate limit exceeded" or "Too many requests"
- **Solution:** Implement retry logic with exponential backoff. Monitor API usage and consider upgrading your OpenAI plan.

### File Upload Issues
- **Error:** "File too large" or "Invalid file type"
- **Solution:** Check backend upload limits and file type validations. Ensure the uploads directory exists and has write permissions.

### Previous Task: Adding TROUBLESHOOTING.md
- **Task:** Create a troubleshooting guide for errors, solutions, testing, and version control.
- **Solution:** Created TROUBLESHOOTING.md with sections for common errors, troubleshooting techniques, testing procedures, and version control practices. Updated README.md to link to the new guide.

## Troubleshooting Techniques

### Debugging Backend Issues
1. Check server logs in the terminal where `npm run dev` is running.
2. Use Postman or curl to test API endpoints directly.
3. Verify environment variables are loaded correctly.

### Debugging Frontend Issues
1. Open browser developer tools (F12) and check the Console tab for errors.
2. Check the Network tab for failed API requests.
3. Use React DevTools to inspect component state.

### Performance Issues
1. Monitor network requests in browser dev tools.
2. Check for memory leaks using browser performance tools.
3. Profile the application to identify bottlenecks.

## Testing

### Running Tests
- Backend: `npm test` (if tests are implemented)
- Frontend: `npm test` (if tests are implemented)

### Manual Testing Checklist
- [ ] Chat functionality works
- [ ] Session creation and switching
- [ ] Message history persistence
- [ ] Code block rendering
- [ ] Responsive design on mobile

### API Testing
Use tools like Postman to test:
- GET /sessions
- POST /sessions
- GET /messages/:sessionId
- POST /messages

## Version Control

### Branching Strategy
- `main`: Production-ready code
- `develop`: Latest development changes
- `feature/*`: New features
- `bugfix/*`: Bug fixes
- `hotfix/*`: Critical fixes for production

### Commit Message Convention
- `feat:` New features
- `fix:` Bug fixes
- `docs:` Documentation changes
- `style:` Code style changes
- `refactor:` Code refactoring
- `test:` Adding or updating tests
- `chore:` Maintenance tasks

### Release Process
1. Merge feature branches into develop
2. Test thoroughly on develop
3. Create release branch from develop
4. Tag release and merge to main
5. Deploy from main branch

## Contributing

When encountering new errors or issues:
1. Document the error and solution here
2. Create a GitHub issue if it's a bug
3. Submit a pull request with the fix

## Logs and Monitoring

- Backend logs are output to the console
- Consider implementing structured logging for production
- Monitor API usage and error rates

---

*Last updated: [Date]*
*Maintainer: [Your Name]*
