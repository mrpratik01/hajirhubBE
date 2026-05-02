/**
 * Client-side Supabase Auth handles sign-in. This repo verifies access tokens in middleware
 * and persists `public.users` via `./users.routes.js`.
 */
const express = require("express");

module.exports = express.Router();
