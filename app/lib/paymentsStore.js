const fs = require('fs').promises;
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'payments.json');

async function ensureFile() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
      await fs.access(FILE);
    } catch (e) {
      await fs.writeFile(FILE, JSON.stringify({ preferences: [], payments: [] }, null, 2), 'utf8');
    }
  } catch (err) {
    console.error('paymentsStore.ensureFile error', err);
    throw err;
  }
}

async function read() {
  await ensureFile();
  const txt = await fs.readFile(FILE, 'utf8');
  return JSON.parse(txt || '{}');
}

async function write(obj) {
  await ensureFile();
  await fs.writeFile(FILE, JSON.stringify(obj, null, 2), 'utf8');
}

async function addPreference(pref) {
  const data = await read();
  data.preferences = data.preferences || [];
  data.preferences.push(pref);
  await write(data);
  return pref;
}

async function updateByPreferenceId(prefId, update) {
  const data = await read();
  data.preferences = data.preferences || [];
  let found = false;
  data.preferences = data.preferences.map(p => {
    if (p.preferenceId == prefId) {
      found = true;
      return Object.assign({}, p, update);
    }
    return p;
  });
  if (!found && update.paymentId) {
    // create record if not found but have payment info
    data.preferences.push(Object.assign({ preferenceId: prefId }, update));
  }
  await write(data);
  return found;
}

async function updateByPaymentId(paymentId, update) {
  const data = await read();
  data.preferences = data.preferences || [];
  let found = false;
  data.preferences = data.preferences.map(p => {
    if (p.paymentId == paymentId) {
      found = true;
      return Object.assign({}, p, update);
    }
    return p;
  });
  if (!found) {
    data.payments = data.payments || [];
    data.payments.push(Object.assign({ paymentId }, update));
  }
  await write(data);
  return found;
}

async function getByPreferenceId(prefId) {
  const data = await read();
  data.preferences = data.preferences || [];
  return data.preferences.find(p => p.preferenceId == prefId) || null;
}

module.exports = {
  addPreference,
  updateByPreferenceId,
  updateByPaymentId,
  getByPreferenceId,
  read,
  write
};
