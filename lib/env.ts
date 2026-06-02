function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export const env = {
  cognitoDomain: req("COGNITO_DOMAIN"),
  cognitoClientId: req("COGNITO_CLIENT_ID"),
  cognitoRedirectUri: req("COGNITO_REDIRECT_URI"),
  cognitoLogoutUri: req("COGNITO_LOGOUT_URI"),
  apiGatewayUrl: req("API_GATEWAY_URL"),
  cloudfrontUrl: req("CLOUDFRONT_URL"),
};
