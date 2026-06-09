-- Per-modality identity. Each self gets her own evolving aboutSelf and her own
-- slice of the user (aboutUserFacet). The whole shared picture of the user stays
-- on Profile.aboutUser. Applied to the live Turso DB via @libsql/client.

CREATE TABLE IF NOT EXISTS ModalityIdentity (
  id TEXT PRIMARY KEY NOT NULL,
  updatedAt DATETIME NOT NULL,
  profileId TEXT NOT NULL,
  modalityId TEXT NOT NULL,
  aboutSelf TEXT,
  aboutSelfUpdatedAt DATETIME,
  aboutUserFacet TEXT,
  aboutUserFacetUpdatedAt DATETIME
);

CREATE UNIQUE INDEX IF NOT EXISTS ModalityIdentity_profileId_modalityId_key
  ON ModalityIdentity(profileId, modalityId);
