data "archive_file" "resize" {
  type        = "zip"
  source_file = "${path.module}/lambda/resize/main.py"
  output_path = "${path.module}/resize.zip"
}

resource "aws_lambda_function" "resize" {
  function_name    = "${local.project}-resize"
  role             = aws_iam_role.resize.arn
  handler          = "main.handler"
  runtime          = "python3.12"
  filename         = data.archive_file.resize.output_path
  source_code_hash = data.archive_file.resize.output_base64sha256
  timeout          = 60
  memory_size      = 1024
  layers           = [var.pillow_layer_arn]

  environment {
    variables = {
      BUCKET_NAME  = aws_s3_bucket.photos.id
      PHOTOS_TABLE = aws_dynamodb_table.photos.name
    }
  }
}

resource "aws_cloudwatch_log_group" "resize" {
  name              = "/aws/lambda/${aws_lambda_function.resize.function_name}"
  retention_in_days = 14
}

resource "aws_lambda_permission" "resize_s3" {
  statement_id  = "AllowS3Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.resize.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.photos.arn
}

resource "aws_s3_bucket_notification" "originals" {
  bucket = aws_s3_bucket.photos.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.resize.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "originals/"
  }

  depends_on = [aws_lambda_permission.resize_s3]
}

data "archive_file" "list_photos" {
  type        = "zip"
  source_file = "${path.module}/lambda/list_photos/main.py"
  output_path = "${path.module}/list_photos.zip"
}

resource "aws_lambda_function" "list_photos" {
  function_name    = "${local.project}-list-photos"
  role             = aws_iam_role.list_photos.arn
  handler          = "main.handler"
  runtime          = "python3.12"
  filename         = data.archive_file.list_photos.output_path
  source_code_hash = data.archive_file.list_photos.output_base64sha256
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      PHOTOS_TABLE      = aws_dynamodb_table.photos.name
      USERS_TABLE       = aws_dynamodb_table.users.name
      CLOUDFRONT_DOMAIN = var.cdn_domain
    }
  }
}

resource "aws_cloudwatch_log_group" "list_photos" {
  name              = "/aws/lambda/${aws_lambda_function.list_photos.function_name}"
  retention_in_days = 14
}
