'use strict';

const jwt = require('jsonwebtoken');

/**
 * JWT_SECRET is resolved at call-time (not at module load) so that
 * Render / Docker can inject the environment variable after the process
 * starts without requiring a restart.
 */
function getSecret() {
  return process.env.JWT_SECRET || 'tcp_sim_secret_key_2024';
}

/**
 * Express middleware — verifies the Bearer JWT in the Authorization header.
 * Attaches decoded payload to req.user on success.
 */
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, getSecret());
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired. Please log in again.' });
    }
    return res.status(401).json({ error: 'Invalid token.' });
  }
}

module.exports = { verifyToken, getSecret };
