// Where the backend API lives. Leave empty when the backend serves this app
// (same origin). When hosting the frontend separately, set the API's URL, e.g.
//   window.EGG_API_BASE = 'https://egg-hunt-api.example.com';
// and add this site's origin to the backend's CORS_ORIGINS.
window.EGG_API_BASE = window.EGG_API_BASE ?? '';
