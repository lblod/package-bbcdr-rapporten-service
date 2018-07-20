import { uuid, sparqlEscapeString, sparqlEscapeDateTime, sparqlEscapeUri } from 'mu';
import { querySudo as query, updateSudo as update } from './auth-sudo';
import fs from 'fs-extra';
import archiver from 'archiver';
import xmlbuilder from 'xmlbuilder';

const filePath = process.env.FILE_PATH || '/data/files/';
const fileGraph = process.env.FILE_GRAPH || 'http://mu.semte.ch/graphs/public';
const STATUS_PROCESSING = "http://mu.semte.ch/vocabularies/ext/bbcdr-status/PACKAGING";
const STATUS_PACKAGED = "http://mu.semte.ch/vocabularies/ext/bbcdr-status/PACKAGED";
const STATUS_PACKAGING_FAILED = "http://mu.semte.ch/vocabularies/ext/bbcdr-status/PACKAGING_FAILED";

/**
 * convert results of select query to an array of objects.
 * @method parseResult
 * @return {Array}
 */
const parseResult = function(result) {
  const bindingKeys = result.head.vars;
  return result.results.bindings.map((row) => {
    const obj = {};
    bindingKeys.forEach((key) => obj[key] = row[key].value);
    return obj;
  });
};

/**
 * convert a file url (share://the/path/to/the/file) to the local path
 * e.g `filePath/the/path/to/the/file`
 * @method fileUrlToPath
 * @return {String}
 */
const fileUrlToPath = function(fileUrl) {
  return fileUrl.replace('share:\/\/', filePath);
};

const pathToFileUrl = function(path) {
  return path.replace(filePath, 'share://');
};

const generateZipFileName = function(report, zipUUID){
  let timestamp = new Date().toISOString().replace(/[.:]/g, '_');
  let bestuur = `${report.classificatieNaam}_${report.naam}`.replace(/[^ -~]+/g, ""); //removes non-ascii, non printable
  return `BBCDR_${bestuur}_${timestamp}_${zipUUID}.zip`;
};

/**
 * create zip file in packagePath with the provided name(.zip),
 * containing the provided files and metadata
 * @method createZipFile
 */
const createZipFile = async function(name, files, borderel) {
  const filename = `${filePath}${name}`;
  var output = await fs.createWriteStream(filename);
  const archive = archiver('zip', {
    zlib: { level: 9 } // Sets the compression level.
  });
  // listen for all archive data to be written
  // 'close' event is fired only when a file descriptor is involved
  output.on('close', function() {
    console.log(`${filename} was created: ${archive.pointer()} bytes`);
  });
  // good practice to catch warnings (ie stat failures and other non-blocking errors)
  archive.on('warning', function(err) {
      throw err;
  });

  // good practice to catch this error explicitly
  archive.on('error', function(err) {
    throw err;
  });
  archive.pipe(output);
  files.map( (file) => {
    archive.file(fileUrlToPath(file.file), {name: file.filename});
  });
  archive.file(borderel, {name: 'borderel.xml'});
  await archive.finalize();
  await fs.unlink(borderel);
  return pathToFileUrl(filename);
};

/**
 * @method createMetaData
 */
const createMetadata = async function(report,files,sleutel = 'test') {
  // see https://github.com/oozcitak/xmlbuilder-js/wiki
  const xml = xmlbuilder.create('ns1:Borderel', {}, {}, {separateArrayItems: true})
          .att('xsi:schemaLocation', 'http://MFT-01-00.abb.vlaanderen.be/Borderel Borderel.xsd')
          .att('xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance')
          .att('xmlns:ns1', 'http://MFT-01-00.abb.vlaanderen.be/Borderel');
  xml.ele({
    'ns1:RouteringsMetadata': {
      Entiteit:'ABB',
      Toepassing: 'BBC DR',
      'ParameterSet': [
        {
          ParameterParameterWaarde: {
            Parameter: 'SLEUTEL',
            ParameterWaarde: sleutel
          }
        },
        {
          ParameterParameterWaarde: {
            Parameter: 'FLOW',
            ParameterWaarde: 'AANLEVERING GEDAAN'
          }
        }
      ]
    },
    'ns1:Bestanden': files.map( (file => { return {Bestand: {Bestandsnaam: file.filename}};}))
  }
  );
  const output = xml.end({pretty: true});
  const filename = `${filePath}${report.id}-borderel.xml`;
  await fs.writeFile(filename, output);
  return filename;
};

/**
 * add package information to a bbcdr report
 * @method addPackage
 */
const addPackage = async function(report, packagePath, packageID, fileName, graph) {
  await update(`
       PREFIX bbcdr: <http://mu.semte.ch/vocabularies/ext/bbcdr/>
       PREFIX nfo: <http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#>
       PREFIX mu:   <http://mu.semte.ch/vocabularies/core/>
       PREFIX dbpedia: <http://dbpedia.org/ontology/>
       PREFIX dcterms: <http://purl.org/dc/terms/>

       INSERT DATA {
         GRAPH <${graph}> {
             ${sparqlEscapeUri(report)} bbcdr:package ${sparqlEscapeUri(packagePath)}.
         }
         GRAPH <${fileGraph}> {
             ${sparqlEscapeUri(packagePath)} a nfo:FileDataObject;
                                             nfo:fileName ${sparqlEscapeString(`${fileName}`)};
                                             dcterms:format "application/zip";
                                             dcterms:created ${sparqlEscapeDateTime(new Date())};
                                             mu:uuid ${sparqlEscapeString(packageID)};
                                             dbpedia:fileExtension "zip".
         }
       }
  `);
};

/**
 * update the internal status of a report
 * @method updateInternalReportStatus
 */
const updateInternalReportStatus = async function(report, status, graph) {
  await update(`
       PREFIX bbcdr: <http://mu.semte.ch/vocabularies/ext/bbcdr/>
       PREFIX dcterms: <http://purl.org/dc/terms/>

       DELETE {
         GRAPH <${graph}> {
             ${sparqlEscapeUri(report)} dcterms:modified ?modified.
             ${sparqlEscapeUri(report)} bbcdr:status ?status.
         }
       }
       WHERE {
         GRAPH <${graph}> {
             {
               ${sparqlEscapeUri(report)} dcterms:modified ?modified.
             }
             UNION
             {
               OPTIONAL{ ${sparqlEscapeUri(report)} bbcdr:status ?status }
             }
         }
       }

       ;

       INSERT DATA {
         GRAPH <${graph}> {
             ${sparqlEscapeUri(report)} dcterms:modified ${sparqlEscapeDateTime(new Date())};
                                        bbcdr:status ${sparqlEscapeUri(status)}.
         }
       }
  `);
};

/**
 * retrieve files linked to a report
 * @method fetchFilesForReport
 * @param {IRI} reportIRI
 * @return {Array}
 */
const fetchFilesForReport = async function(report, graph) {
  const result = await query(`
       PREFIX mu:   <http://mu.semte.ch/vocabularies/core/>
       PREFIX nie:     <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>
       PREFIX nfo: <http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#>
       PREFIX dcterms: <http://purl.org/dc/terms/>
       PREFIX adms:    <http://www.w3.org/ns/adms#>
       PREFIX bbcdr: <http://mu.semte.ch/vocabularies/ext/bbcdr/>

       SELECT ?file ?filename ?format ?size
       WHERE {
         GRAPH <${graph}> {
             ${sparqlEscapeUri(report)} a bbcdr:Report;
                                        nie:hasPart ?uploadFile.
         }

         GRAPH <${fileGraph}> {
             ?uploadFile nfo:fileName ?filename.
             ?file nie:dataSource ?uploadFile;
                   dcterms:format ?format;
                   nfo:fileSize ?size.
         }
       }
`);
  return parseResult(result);
};

/**
 * fetch reports in sent status that are not yet packaged
 * @method fetchReportsToBePackaged
 * @return {Array}
 */
const fetchReportsToBePackaged = async function() {
  const result = await query(`
       PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
       PREFIX besluit: <http://data.vlaanderen.be/ns/besluit#>
       PREFIX mu:   <http://mu.semte.ch/vocabularies/core/>
       PREFIX nie:     <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>
       PREFIX nfo: <http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#>
       PREFIX dcterms: <http://purl.org/dc/terms/>
       PREFIX adms:    <http://www.w3.org/ns/adms#>
       PREFIX bbcdr: <http://mu.semte.ch/vocabularies/ext/bbcdr/>
       PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
       PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>


       SELECT ?uri ?id ?graph ?bestuurseenheid ?naam ?kbonummer ?classificatieNaam
       WHERE {

         GRAPH ?graph {
             ?uri a bbcdr:Report;
                     adms:status <http://data.lblod.info/document-statuses/verstuurd>;
                     mu:uuid ?id;
                     dcterms:modified ?modified;
                     dcterms:subject ?bestuurseenheid.
             FILTER NOT EXISTS {
                ?uri bbcdr:status ?status.
             }
         }

         GRAPH <http://mu.semte.ch/graphs/public> {
             ?bestuurseenheid skos:prefLabel ?naam;
                               ext:kbonummer ?kbonummer;
                               besluit:classificatie ?classificatie;
                               mu:uuid ?groupId .
              ?classificatie skos:prefLabel ?classificatieNaam.

         }

         FILTER(?graph = IRI(CONCAT("http://mu.semte.ch/graphs/organizations/", ?groupId, "/LoketLB-bbcdrGebruiker")))

      } ORDER BY ASC(?modified)
`);
  return parseResult(result);
};

/**
 * cleanup running tasks
 */
const cleanup = async function() {
  await update(`
     PREFIX bbcdr: <http://mu.semte.ch/vocabularies/ext/bbcdr/>

     DELETE {
       GRAPH ?g {
           ?report bbcdr:status ${sparqlEscapeUri(STATUS_PROCESSING)}.
       }
     } WHERE {
       GRAPH ?g {
           ?report a bbcdr:Report;
                     bbcdr:status ${sparqlEscapeUri(STATUS_PROCESSING)}.
       }
     }
  `);
};

/**
 * is a packaging task already return
 * @return {boolean} Whether a packaging task is currently running
 */
async function isRunning() {
  const queryResult = await query(`
     PREFIX bbcdr: <http://mu.semte.ch/vocabularies/ext/bbcdr/>

     ASK {
       GRAPH ?g {
         ?report a bbcdr:Report;
                 bbcdr:status ${sparqlEscapeUri(STATUS_PROCESSING)}.
       }
     }`);
  return queryResult.boolean;
}
export { isRunning, cleanup, addPackage, generateZipFileName, createZipFile, createMetadata, updateInternalReportStatus, fetchReportsToBePackaged, fetchFilesForReport, STATUS_PROCESSING, STATUS_PACKAGED, STATUS_PACKAGING_FAILED };
