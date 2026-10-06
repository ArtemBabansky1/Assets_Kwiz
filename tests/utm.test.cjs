const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../kwiz.js'), 'utf8');
// Run the shipped script; leave DOM boot pending and expose submission functions.
const instrumented = source.replace(/\}\)\(\);\s*$/, `
  globalThis.quizTest = { submitLead, sendGift, FORM_DATA, ANSWERS };
})();`);

function load(search, storage = new Map(), blocked = false) {
  const requests = [];
  const window = {
    location: { search, href: 'https://example.com/quiz' + search },
    get sessionStorage() {
      if (blocked) throw new Error('Storage blocked');
      return {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      };
    },
  };
  const context = vm.createContext({
    window, URL, URLSearchParams, FormData,
    document: { currentScript: null, readyState: 'loading', addEventListener() {} },
    setTimeout: () => 1, clearTimeout() {},
    fetch(url, options) {
      requests.push({ url, data: Object.fromEntries(options.body.entries()) });
      return Promise.resolve({ ok: true });
    },
  });
  vm.runInContext(instrumented, context);
  Object.assign(context.quizTest.FORM_DATA, {
    name: 'UTM Test', phone: '+12025550123', email: 'utm@example.com',
    company: 'Test', 'trip-frequency': 'Less than 10 business trips per month',
  });
  context.quizTest.ANSWERS.stage1 = { key: 'finance-manager', label: 'Finance manager' };
  const form = { querySelector: () => null };
  return {
    window, requests,
    lead: () => context.quizTest.submitLead('forma', form),
    gift: () => context.quizTest.sendGift(form),
  };
}

const campaign = {
  utm_source: 'google', utm_medium: 'paid search', utm_campaign: 'Осень & demo',
  utm_term: 'business+travel', utm_content: 'banner/1', utm_id: '123',
};
const search = '?' + new URLSearchParams(campaign);

test('both form requests include decoded UTM and retain existing fields', () => {
  const quiz = load(search + '&irrelevant=ignore');
  quiz.lead();
  quiz.gift();
  assert.equal(quiz.requests[0].url, 'https://tumodo.io/quiz-form');
  assert.equal(quiz.requests[1].url, 'https://tumodo.io/quiz-gift');
  for (const request of quiz.requests) {
    for (const [key, value] of Object.entries(campaign)) assert.equal(request.data[key], value);
    assert.equal(request.data.irrelevant, undefined);
    assert.equal(request.data.email, 'utm@example.com');
  }
  assert.equal(quiz.requests[0].data.firstname, 'UTM Test');
  assert.equal(quiz.requests[0].data.jobtitle, 'Finance manager');
  assert.equal(quiz.requests[1].data.variant, 'finance-manager');
});

test('UTM survive URL cleanup and reload in the same session', () => {
  const storage = new Map();
  const quiz = load(search, storage);
  quiz.window.location.search = '';
  quiz.lead();
  const reloaded = load('', storage);
  reloaded.lead();
  for (const request of [quiz.requests[0], reloaded.requests[0]]) {
    for (const [key, value] of Object.entries(campaign)) assert.equal(request.data[key], value);
  }
});

test('a new campaign replaces the old group without mixing attribution', () => {
  const storage = new Map();
  load(search, storage);
  const quiz = load('?utm_source=newsletter&utm_medium=email', storage);
  quiz.lead();
  assert.equal(quiz.requests[0].data.utm_source, 'newsletter');
  assert.equal(quiz.requests[0].data.utm_campaign, undefined);
  quiz.window.location.search = '?utm_source=partner';
  quiz.lead();
  assert.equal(quiz.requests[1].data.utm_source, 'partner');
  assert.equal(quiz.requests[1].data.utm_medium, undefined);
});

test('blocked storage does not prevent submission or in-memory retention', () => {
  const quiz = load(search, new Map(), true);
  quiz.window.location.search = '';
  quiz.lead();
  assert.equal(quiz.requests[0].data.utm_campaign, campaign.utm_campaign);
});

test('untagged visits omit empty fields and tolerate corrupt storage', () => {
  for (const storage of [new Map(), new Map([['tumodo_kwiz_utm', '{broken']]),
    new Map([['tumodo_kwiz_utm', 'null']])]) {
    const quiz = load('?utm_source=&utm_campaign=%20', storage);
    quiz.lead();
    assert.equal(quiz.requests[0].data.utm_source, undefined);
    assert.equal(quiz.requests[0].data.utm_campaign, undefined);
  }
});
