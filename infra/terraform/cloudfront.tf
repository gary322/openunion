locals {
  # CloudFront is only used when running in router mode (no ALB). It provides HTTPS and a stable
  # public endpoint without requiring ELB/ALB support in the AWS account.
  cloudfront_enabled = var.enable_router_instance && var.enable_cloudfront
}

resource "aws_cloudfront_cache_policy" "no_cache" {
  count = local.cloudfront_enabled ? 1 : 0

  name        = "${local.name}-no-cache"
  comment     = "Disable caching for dynamic API + SPA content."
  default_ttl = 0
  max_ttl     = 0
  min_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    # CloudFront disallows accept-encoding settings when caching is fully disabled (TTL=0).
    enable_accept_encoding_gzip   = false
    enable_accept_encoding_brotli = false

    cookies_config {
      cookie_behavior = "none"
    }

    headers_config {
      header_behavior = "none"
    }

    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_origin_request_policy" "all_viewer" {
  count = local.cloudfront_enabled ? 1 : 0

  name    = "${local.name}-all-viewer"
  comment = "Forward all viewer headers/cookies/query-strings (Auth, CSRF, etc)."

  cookies_config {
    cookie_behavior = "all"
  }

  headers_config {
    header_behavior = "allViewer"
  }

  query_strings_config {
    query_string_behavior = "all"
  }
}

resource "aws_cloudfront_distribution" "router" {
  count = local.cloudfront_enabled ? 1 : 0

  enabled         = true
  is_ipv6_enabled = true
  price_class     = var.cloudfront_price_class
  comment         = "${local.name} router distribution"

  origin {
    origin_id   = "router"
    domain_name = aws_instance.router[0].public_dns

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "router"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    allowed_methods = ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"]
    cached_methods  = ["GET", "HEAD", "OPTIONS"]

    cache_policy_id          = aws_cloudfront_cache_policy.no_cache[0].id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.all_viewer[0].id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
    minimum_protocol_version       = "TLSv1.2_2021"
  }
}
