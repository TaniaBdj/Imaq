/**
 * Route planning — deliberately simple and explainable. No maps, no optimiser.
 *
 *  1. Each household belongs to a truck. If that truck is out of service, its
 *     households are redistributed (most urgent first) to the operating truck
 *     with the fewest assigned households.
 *  2. A household is on TODAY's route if it was not already served today and
 *     either its scheduled delivery is due by the end of today or its priority is HIGH.
 *  3. Each truck's route is sorted by priority score (most urgent first).
 *  4. A truck serves at most `maxStopsPerDay`; the rest move to tomorrow (delayed).
 *  5. With no operating truck, deliveries are delayed.
 */

const DAY = 86_400_000;

export function endOfDay(ts, plusDays = 0) {
  const d = new Date(ts);
  d.setHours(23, 59, 59, 999);
  return d.getTime() + plusDays * DAY;
}

/**
 * @param {object} p
 * @param {Array<{id, assignedTruck, score, priorityLevel, dueTs, servedToday}>} p.households
 * @param {Array<{id, status}>} p.trucks
 * @param {number} p.now
 * @param {number} [p.maxStopsPerDay]
 */
export function planRoutes({ households, trucks, now, maxStopsPerDay = 6 }) {
  const operating = trucks.filter((t) => t.status === 'OPERATING').map((t) => t.id).sort();
  const byUrgency = [...households].sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));

  // 1. Effective truck per household
  const load = Object.fromEntries(operating.map((id) => [id, households.filter((h) => h.assignedTruck === id).length]));
  const truckOf = {};
  const reassigned = {};
  for (const h of byUrgency) {
    if (operating.includes(h.assignedTruck)) {
      truckOf[h.id] = h.assignedTruck;
    } else if (operating.length) {
      const target = [...operating].sort((a, b) => load[a] - load[b] || a.localeCompare(b))[0];
      load[target] += 1;
      truckOf[h.id] = target;
      reassigned[h.id] = true;
    } else {
      truckOf[h.id] = null;
    }
  }

  // 2–4. Today's stops per truck
  const eod = endOfDay(now);
  const routes = Object.fromEntries(trucks.map((t) => [t.id, { today: [], overflow: [] }]));
  const plan = {};
  for (const h of byUrgency) {
    const truckId = truckOf[h.id];
    const dueToday = !h.servedToday && (h.dueTs <= eod || h.priorityLevel === 'HIGH');
    let when;
    let delayed = false;
    if (!truckId) {
      when = 'delayed';
      delayed = true;
    } else if (dueToday) {
      if (routes[truckId].today.length < maxStopsPerDay) {
        routes[truckId].today.push(h.id);
        when = 'today';
      } else {
        routes[truckId].overflow.push(h.id);
        when = 'tomorrow';
        delayed = true;
      }
    } else {
      const due = Math.max(h.dueTs, now);
      when = due <= endOfDay(now, 1) ? 'tomorrow' : 'later';
    }
    plan[h.id] = { truckId, when, delayed, reassigned: !!reassigned[h.id], originalTruck: h.assignedTruck, dueTs: h.dueTs };
  }
  for (const [truckId, r] of Object.entries(routes)) {
    r.today.forEach((id, i) => {
      plan[id].position = i + 1;
      plan[id].stops = r.today.length;
    });
    r.assigned = households.filter((h) => truckOf[h.id] === truckId).map((h) => h.id);
  }
  const affected = households.filter((h) => !operating.includes(h.assignedTruck)).map((h) => h.id);
  return { plan, routes, operating, affected };
}
