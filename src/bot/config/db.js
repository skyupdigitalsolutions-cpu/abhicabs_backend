'use strict';
/**
 * The bot no longer owns a database connection. It uses the backend's single
 * Prisma client, so the bot, the website API and the mobile apps all read and
 * write the same tables over the same connection pool.
 */
const { prisma } = require('../../config/prisma');

async function connectDB() { return prisma; }      // backend server.js already connects
async function disconnectDB() { /* backend owns shutdown */ }
function getPrisma() { return prisma; }

module.exports = { connectDB, disconnectDB, getPrisma };
