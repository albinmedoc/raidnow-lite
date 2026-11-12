export function createBrowserResetController({ suspend, requestReset, resume, clearLocalData, reload }) {
  let inFlight = null;
  return {
    run() {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        suspend();
        try {
          await requestReset();
        } catch (error) {
          await resume();
          inFlight = null;
          throw error;
        }
        clearLocalData();
        reload();
      })();
      return inFlight;
    }
  };
}

export function formatTrainerCode(value) {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 12);
  if (!digits) return '—';
  return digits.match(/.{1,4}/g).join(' ');
}

export function isCurrentMatchedRaid(status, raid) {
  return status?.state === 'matched'
    && Boolean(status.raid?.rpl_id)
    && status.raid.rpl_id === raid?.rpl_id;
}
