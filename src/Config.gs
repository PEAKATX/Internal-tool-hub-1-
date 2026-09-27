/**
 * Config.gs
 * Wraps Script Properties (per-environment, not touched by `clasp push`)
 * and the Config tab (in-sheet dropdown values, editable without code).
 *
 * Required Script Properties per environment, set once under
 * Project Settings -> Script Properties:
 *   SHEET_ID            - the database Spreadsheet ID for this environment
 *   ENV                 - "dev" | "prod"
 *   RECEIPTS_FOLDER_ID  - Drive folder for expense receipt uploads
 *   EXPORTS_FOLDER_ID   - Drive folder for admin exports
 *   EMAIL_OVERRIDE      - (dev only, optional) email to impersonate for
 *                         testing access levels — see Auth.gs
 */

function getDb_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('Script Property SHEET_ID is not set for this project.');
  return SpreadsheetApp.openById(id);
}

function getEnv_() {
  return PropertiesService.getScriptProperties().getProperty('ENV') || 'dev';
}

function isProd_() {
  return getEnv_() === 'prod';
}

function getFolder_(propertyName) {
  const id = PropertiesService.getScriptProperties().getProperty(propertyName);
  if (!id) throw new Error('Script Property ' + propertyName + ' is not set.');
  return DriveApp.getFolderById(id);
}

/**
 * Reads all Config-tab rows for a given category, e.g. configValues_('department')
 * -> ['Programmes', 'Engineering', 'Finance', 'Communications', 'Operations']
 */
function configValues_(category) {
  const sheet = getDb_().getSheetByName('Config');
  const rows = sheet.getDataRange().getValues();
  const map = columnMap_('Config');
  return rows
    .slice(1) // skip header
    .filter(function (row) { return row[map.category - 1] === category; })
    .map(function (row) { return row[map.value - 1]; });
}

function adminEmails_() {
  return configValues_('admin_email').map(function (e) {
    return String(e).toLowerCase().trim();
  });
}
