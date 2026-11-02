window.searchIndex = {
  fields: ["title", "description", "path", "body"],
  pipeline: ["trimmer", "stopWordFilter", "stemmer"],
  ref: "id",
  version: "0.9.5",
  index: {
    title: { root: { docs: {}, df: 0 } },
    description: { root: { docs: {}, df: 0 } },
    path: { root: { docs: {}, df: 0 } },
    body: { root: { docs: {}, df: 0 } },
  },
  documentStore: {
    docs: {},
    docInfo: {},
    length: 0,
  },
  lang: "Korean",
};
