const jwt = require("jsonwebtoken");
const config = require("../config/database");

/**
 * Authentication middleware - verifies access token
 */
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing token" });
  }
  
  const token = auth.split(" ")[1];
  
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    req.user = payload;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired", code: "TOKEN_EXPIRED" });
    }
    return res.status(401).json({ error: "Invalid token" });
  }
}

/**
 * Optional authentication middleware - doesn't fail if no token
 */
function optionalAuth(req, res, next) {
  const auth = req.headers.authorization;
  
  if (!auth || !auth.startsWith("Bearer ")) {
    return next();
  }
  
  const token = auth.split(" ")[1];
  
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    req.user = payload;
  } catch (err) {
    // Token invalid, continue without user
  }
  
  next();
}

module.exports = {
  authMiddleware,
  optionalAuth
};
