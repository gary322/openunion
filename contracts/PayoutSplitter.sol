// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal payout splitter that atomically transfers net+fee in a single transaction.
/// The payer is `msg.sender` (the off-chain signer / treasury wallet). The payer must approve
/// this contract to spend USDC before calling `payout`.
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract PayoutSplitter {
    event Payout(
        address indexed token,
        address indexed payer,
        address indexed worker,
        address platform,
        uint256 netAmount,
        uint256 feeAmount
    );

    event PayoutV2(
        address indexed token,
        address indexed payer,
        address indexed worker,
        address platform,
        address proofwork,
        uint256 netAmount,
        uint256 platformFeeAmount,
        uint256 proofworkFeeAmount
    );

    bool public paused;
    address public owner;

    modifier onlyOwner() {
        require(msg.sender == owner, "not_owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setPaused(bool v) external onlyOwner {
        paused = v;
    }

    /// @notice Transfers `net` to `worker` and `fee` to `platform` from `msg.sender`.
    function payout(address token, address worker, address platform, uint256 net, uint256 fee) external {
        require(!paused, "paused");
        require(worker != address(0) && platform != address(0), "bad_address");

        if (net > 0) {
            require(IERC20(token).transferFrom(msg.sender, worker, net), "net_transfer_failed");
        }
        if (fee > 0) {
            require(IERC20(token).transferFrom(msg.sender, platform, fee), "fee_transfer_failed");
        }

        emit Payout(token, msg.sender, worker, platform, net, fee);
    }

    /// @notice Transfers `net` to `worker`, `platformFee` to `platform` and `proofworkFee` to `proofwork` from `msg.sender`.
    /// Platform is optional only when `platformFee == 0` (platform can be address(0) in that case).
    function payoutV2(
        address token,
        address worker,
        address platform,
        address proofwork,
        uint256 net,
        uint256 platformFee,
        uint256 proofworkFee
    ) external {
        require(!paused, "paused");
        require(worker != address(0) && proofwork != address(0), "bad_address");
        if (platformFee > 0) {
            require(platform != address(0), "bad_platform");
        }

        if (net > 0) {
            require(IERC20(token).transferFrom(msg.sender, worker, net), "net_transfer_failed");
        }
        if (platformFee > 0) {
            require(IERC20(token).transferFrom(msg.sender, platform, platformFee), "platform_fee_transfer_failed");
        }
        if (proofworkFee > 0) {
            require(IERC20(token).transferFrom(msg.sender, proofwork, proofworkFee), "proofwork_fee_transfer_failed");
        }

        emit PayoutV2(token, msg.sender, worker, platform, proofwork, net, platformFee, proofworkFee);
    }
}
