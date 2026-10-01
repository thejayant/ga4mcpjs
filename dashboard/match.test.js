import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokens, similarity, bestMatch, autoSelect } from './match.js';

const accounts = {
  ga4: { status: 'ready', data: [{ id: 'properties/1', name: 'Get_Carports_GA4', account: 'Get Carports' }, { id: 'properties/2', name: 'Coast to Coast Carports - GA4', account: 'C2C' }, { id: 'properties/3', name: 'ProBuilt Steel', account: 'ProBuilt' }] },
  search_console: { status: 'ready', data: [{ id: 'https://www.getcarports.com/', name: 'https://www.getcarports.com/', account: 'URL prefix' }, { id: 'https://www.coast-to-coastcarports.com/', name: 'https://www.coast-to-coastcarports.com/', account: 'URL prefix' }, { id: 'sc-domain:carportdirect.com', name: 'carportdirect.com', account: 'Domain property' }] },
  google_ads: { status: 'ready', data: [{ id: '1111111111', name: '111-111-1111' }, { id: '2222222222', name: '222-222-2222' }] },
  merchant_center: { status: 'ready', data: [{ id: '9', name: 'Get Carports Store', account: 'getcarports.com' }] },
  gbp: { status: 'ready', data: [{ id: 'accounts/1/locations/1', name: 'Get Carports', account: 'Mount Airy, NC' }, { id: 'accounts/1/locations/2', name: 'Metal Garage Central', account: 'Dobson, NC' }] },
  callrail: { status: 'error', message: 'no token' }
};
const params = { ga4: 'propertyId', search_console: 'siteUrl', google_ads: 'customerId', merchant_center: 'merchantAccountId', gbp: 'gbpLocation', callrail: 'callrailAccountId' };

test('names reduce to the same business core', () => {
  assert.deepEqual(tokens('Get_Carports_GA4'), ['get', 'carports']);
  assert.deepEqual(tokens('https://www.getcarports.com/'), ['getcarports']);
  assert.equal(similarity('getcarports.com', 'Get_Carports_GA4'), 100);
  assert.equal(similarity('getcarports.com', 'Coast to Coast Carports - GA4'), 0);
});

test('a business name picks that business in every source it can', () => {
  const { selection, matched } = autoSelect(accounts, params, 'getcarports.com');
  assert.deepEqual(selection, { propertyId: 'properties/1', siteUrl: 'https://www.getcarports.com/', merchantAccountId: '9', gbpLocation: 'accounts/1/locations/1' });
  assert.deepEqual(matched, ['ga4', 'search_console', 'merchant_center', 'gbp']);
  assert.equal(bestMatch(accounts.ga4.data, 'Coast to Coast Carports').id, 'properties/2');
  assert.equal(bestMatch(accounts.ga4.data, 'unrelated business'), null);
});

test('without a name, only single-account sources are chosen', () => {
  const { selection } = autoSelect(accounts, params, '');
  assert.deepEqual(selection, { merchantAccountId: '9' });
});

test('a named business never borrows another business\'s only account', () => {
  const single = {
    gbp: { status: 'ready', data: [{ id: 'accounts/1/locations/2', name: 'Metal Garage Central', account: 'Dobson, NC' }] },
    google_ads: { status: 'ready', data: [{ id: '2756458445', name: '275-645-8445' }] }
  };
  const { selection } = autoSelect(single, { gbp: 'gbpLocation', google_ads: 'customerId' }, 'carportdirect.com');
  assert.deepEqual(selection, { customerId: '2756458445' }, 'nameless Ads account is used; unrelated location is not');
});
