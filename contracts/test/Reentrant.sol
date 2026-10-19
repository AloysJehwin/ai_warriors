// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IVault {
    function release(bytes32 id) external;
    function pay(address payable vendor, uint256 amount, bytes32 incidentHash) external;
}

/// Test helper: a malicious vendor that tries to re-enter the vault when paid.
contract ReentrantVendor {
    IVault public vault;
    bytes32 public id;
    bool public attempted;
    bool public reentered;

    function arm(IVault v, bytes32 i) external {
        vault = v;
        id = i;
    }

    receive() external payable {
        if (attempted) return;
        attempted = true;
        try vault.release(id) {
            reentered = true;
        } catch {}
    }
}
