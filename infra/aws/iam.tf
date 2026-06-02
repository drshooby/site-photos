data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# resize
resource "aws_iam_role" "resize" {
  name               = "${local.project}-resize"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "resize" {
  statement {
    actions   = ["s3:GetObject", "s3:HeadObject"]
    resources = ["${aws_s3_bucket.photos.arn}/originals/*"]
  }
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.photos.arn}/processed/*"]
  }
  statement {
    actions   = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem"]
    resources = [aws_dynamodb_table.photos.arn]
  }
  statement {
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "resize" {
  role   = aws_iam_role.resize.id
  policy = data.aws_iam_policy_document.resize.json
}

# list_photos
resource "aws_iam_role" "list_photos" {
  name               = "${local.project}-list-photos"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "list_photos" {
  statement {
    actions = ["dynamodb:Query", "dynamodb:Scan", "dynamodb:GetItem"]
    resources = [
      aws_dynamodb_table.photos.arn,
      "${aws_dynamodb_table.photos.arn}/index/*",
      aws_dynamodb_table.users.arn,
    ]
  }
  statement {
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "list_photos" {
  role   = aws_iam_role.list_photos.id
  policy = data.aws_iam_policy_document.list_photos.json
}

# admin
resource "aws_iam_role" "admin" {
  name               = "${local.project}-admin"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "admin" {
  statement {
    actions = [
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:HeadObject",
    ]
    resources = ["${aws_s3_bucket.photos.arn}/*"]
  }
  statement {
    actions = ["dynamodb:GetItem", "dynamodb:DeleteItem", "dynamodb:Query"]
    resources = [
      aws_dynamodb_table.photos.arn,
      "${aws_dynamodb_table.photos.arn}/index/*",
      aws_dynamodb_table.users.arn,
    ]
  }
  statement {
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "admin" {
  role   = aws_iam_role.admin.id
  policy = data.aws_iam_policy_document.admin.json
}
