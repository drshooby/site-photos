resource "aws_dynamodb_table" "photos" {
  name         = "${local.project}-photos"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "photo_id"

  attribute {
    name = "photo_id"
    type = "S"
  }

  attribute {
    name = "is_public_str"
    type = "S"
  }

  attribute {
    name = "created_at"
    type = "S"
  }

  global_secondary_index {
    name            = "public-index"
    hash_key        = "is_public_str"
    range_key       = "created_at"
    projection_type = "ALL"
  }
}

resource "aws_dynamodb_table" "users" {
  name         = "${local.project}-users"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "email"

  attribute {
    name = "email"
    type = "S"
  }
}

resource "aws_dynamodb_table_item" "admin_seed" {
  table_name = aws_dynamodb_table.users.name
  hash_key   = aws_dynamodb_table.users.hash_key

  item = jsonencode({
    email = { S = lower(var.admin_email) }
    role  = { S = "admin" }
  })

  lifecycle {
    ignore_changes = [item]
  }
}
