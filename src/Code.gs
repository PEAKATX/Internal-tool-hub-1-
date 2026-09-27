/**
 * Code.gs
 * Web app entry point. Keep this file thin — it routes, it doesn't
 * contain business logic. Each feature module (Tasks.gs, Reports.gs, ...)
 * owns its own client-callable functions via google.script.run.
 */

function doGet(e) {
  const user = currentUser_(); // null if no active Staff record

  const template = HtmlService.createTemplateFromFile('ui/Index');
  template.user = user; // null triggers the "access denied" view client-side

  return template.evaluate()
    .setTitle('AfroTechXcel Staff Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Lets HTML templates pull in other HTML files, e.g. <?!= include('ui/Styles') ?> */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Single client-callable entry point for "who am I / what can I see".
 * The client calls this on load; every module's own functions still
 * re-check access server-side rather than trusting this response.
 */
function bootstrap() {
  const user = currentUser_();
  if (!user) {
    return { authenticated: false };
  }
  return {
    authenticated: true,
    user: user,
    env: getEnv_()
  };
}
