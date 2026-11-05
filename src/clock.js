// "Today" decides whether a grant deadline has passed. It is the server's local date
// (set TZ for the communities' timezone), or a fixed date from TODAY / tests.

function localDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** @param {{ today?: string|null }} [opts] */
export function createClock({ today = null } = {}) {
  let fixed = today;
  return {
    /** @returns {string} YYYY-MM-DD */
    today: () => fixed ?? localDate(new Date()),
    /** Tests move the date forward to check deadlines at confirm time. */
    set: (date) => { fixed = date; },
  };
}
