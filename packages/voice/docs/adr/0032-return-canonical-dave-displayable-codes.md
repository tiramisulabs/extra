# Return canonical DAVE displayable codes

`voicePrivacyCode` and `getVerificationCode()` return only ASCII decimal digits, preserve leading zeroes, and contain no spaces, hyphens, or other presentation separators. Their lengths are exactly 30 and 45 characters respectively, and `voicePrivacyCodeChange` uses the same canonical representation.

DAVE's displayable-code algorithm constructs fixed five-digit groups and concatenates them. Visual separation of those groups is application presentation, so the protocol package will not add an alternative formatted representation or a formatting helper.
