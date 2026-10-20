// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OrdoProofs} from "../src/OrdoProofs.sol";
import {IStageVerifier} from "../src/OrdoLotResolver.sol";

/// Exposes OrdoProofs to the tests, and checks one stage proof the way OrdoLotResolver does (which needs ENSv2 to run).
contract ProofsHarness {
    IStageVerifier public immutable verifier;

    constructor(IStageVerifier _verifier) {
        verifier = _verifier;
    }

    function releaseSigner(OrdoProofs.ReleaseSig calldata s, OrdoProofs.ReleaseLot calldata lot, string calldata meaning) external view returns (address) {
        return OrdoProofs.releaseSigner(s, lot, meaning);
    }

    function subjectOf(string calldata site, string calldata runId, string calldata stage) external pure returns (uint256) {
        return OrdoProofs.subjectOf(site, runId, stage);
    }

    /// The reading's signer, if the proof verifies; and the proof root after folding this stage into `root`.
    function checkStage(string calldata site, string calldata runId, bytes32 root, OrdoProofs.StageProof calldata p) external view returns (address attester, bytes32 next) {
        attester = OrdoProofs.recover(OrdoProofs.readingDigest(site, runId, p), p.readingSig);
        uint256 subject = OrdoProofs.subjectOf(site, runId, p.stage);
        require(verifier.verifyProof(p.a, p.b, p.c, OrdoProofs.signals(subject, p)), "bad proof");
        next = OrdoProofs.fold(root, subject, p, attester);
    }
}
