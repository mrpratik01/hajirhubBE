/**
 * Unified error handler for API controllers.
 */
function handleError(res, err, context = "Operation") {
  const msg = err.message || `${context} failed`;

  // Log error for debugging
  console.error(`[${context}] Error:`, err);

  if (msg.includes("not found")) return res.status(404).json({ error: msg });
  if (
    msg.includes("required") ||
    msg.includes("Invalid JSON") ||
    msg.includes("must be") ||
    msg.includes("already registered") ||
    msg.includes("already assigned")
  ) {
    return res.status(400).json({ error: msg });
  }
  if (msg.includes("Not authorized") || msg.includes("access denied")) {
    return res.status(403).json({ error: msg });
  }
  if (msg.includes("already exists") || msg.includes("Duplicate")) {
    return res.status(409).json({ error: msg });
  }

  return res.status(500).json({ error: msg });
}

module.exports = { handleError };
