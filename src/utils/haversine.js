/**
 * Calculate the great circle distance between two points on earth using the Haversine formula.
 * @param {number} lat1 - Latitude of first point in degrees
 * @param {number} lng1 - Longitude of first point in degrees  
 * @param {number} lat2 - Latitude of second point in degrees
 * @param {number} lng2 - Longitude of second point in degrees
 * @returns {number} Distance in meters
 */
function haversineDistanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth's radius in meters
  const φ1 = lat1 * Math.PI / 180; // Convert to radians
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) *
    Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

module.exports = { haversineDistanceM };
