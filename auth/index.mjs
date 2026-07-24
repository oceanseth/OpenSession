/**
 * GitHub OAuth code→token exchange for opensession.groupnetwork.com.
 *
 * The SPA can't hold the OAuth client secret, so this Lambda (behind a
 * public function URL; CORS is configured on the URL itself) performs the
 * exchange. It holds no state and returns GitHub's response fields verbatim
 * minus anything we don't need.
 */
export const handler = async (event) => {
  if (event.requestContext?.http?.method !== 'POST') {
    return json(405, { error: 'method_not_allowed' });
  }
  let code;
  try {
    ({ code } = JSON.parse(event.body ?? '{}'));
  } catch {
    return json(400, { error: 'bad_request', error_description: 'body must be JSON' });
  }
  if (!code || typeof code !== 'string') {
    return json(400, { error: 'bad_request', error_description: 'missing code' });
  }
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GH_CLIENT_ID,
      client_secret: process.env.GH_CLIENT_SECRET,
      code,
    }),
  });
  const data = await res.json();
  if (data.error) {
    return json(400, { error: data.error, error_description: data.error_description });
  }
  return json(200, { access_token: data.access_token, scope: data.scope, token_type: data.token_type });
};

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
