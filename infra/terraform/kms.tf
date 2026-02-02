resource "aws_kms_key" "payout_signer" {
  description              = "${local.name} payout signer (secp256k1)"
  deletion_window_in_days  = 30
  enable_key_rotation      = false
  customer_master_key_spec = "ECC_SECG_P256K1"
  key_usage                = "SIGN_VERIFY"
}

resource "aws_kms_alias" "payout_signer" {
  name          = "alias/${local.name}-payout-signer"
  target_key_id = aws_kms_key.payout_signer.key_id
}

