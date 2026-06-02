resource "aws_api_gateway_rest_api" "main" {
  name = "${local.project}-api"
}

resource "aws_api_gateway_authorizer" "cognito" {
  name          = "cognito"
  type          = "COGNITO_USER_POOLS"
  rest_api_id   = aws_api_gateway_rest_api.main.id
  provider_arns = [aws_cognito_user_pool.main.arn]
}

# /photos
resource "aws_api_gateway_resource" "photos" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_rest_api.main.root_resource_id
  path_part   = "photos"
}

resource "aws_api_gateway_method" "photos_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.photos.id
  http_method   = "GET"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "photos_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.photos.id
  http_method             = aws_api_gateway_method.photos_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.list_photos.invoke_arn
}

# /photos/private
resource "aws_api_gateway_resource" "photos_private" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.photos.id
  path_part   = "private"
}

resource "aws_api_gateway_method" "photos_private_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.photos_private.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "photos_private_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.photos_private.id
  http_method             = aws_api_gateway_method.photos_private_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.list_photos.invoke_arn
}

# Lambda invoke permission for both routes
resource "aws_lambda_permission" "apigw_list_photos" {
  statement_id  = "AllowAPIGatewayInvokeListPhotos"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.list_photos.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

# Deployment + stage (recreated when any route changes)
resource "aws_api_gateway_deployment" "main" {
  rest_api_id = aws_api_gateway_rest_api.main.id

  triggers = {
    redeploy = sha1(jsonencode([
      aws_api_gateway_method.photos_get.id,
      aws_api_gateway_integration.photos_get.id,
      aws_api_gateway_method.photos_private_get.id,
      aws_api_gateway_integration.photos_private_get.id,
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_api_gateway_stage" "prod" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  deployment_id = aws_api_gateway_deployment.main.id
  stage_name    = "prod"
}
