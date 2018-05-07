import { query, update, uuid, sparqlEscapeString, sparqlEscapeDateTime, sparqlEscapeUri } from 'mu';
import fs from 'fs';
import archiver from 'archiver';
import xmlbuilder from 'xmlbuilder';

const filePath = process.env.FILE_PATH || '/data/files/';
const STATUS_PROCESSING = "http://mu.semte.ch/vocabularies/ext/bbcdr-status/PACKAGING";
const STATUS_PACKAGED = "http://mu.semte.ch/vocabularies/ext/bbcdr-status/PACKAGED";


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

/**
 * create zip file in packagePath with the provided name(.zip),
 * containing the provided files and metadata
 * @method createZipFile
 */
const createZipFile = async function(name, files, borderel) {
  const filename = `${filePath}${name}.zip`;
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
  const xml = xmlbuilder.create('ns1:Borderel')
          .att('xsi:schemaLocation', 'http://MFT-01-00.abb.vlaanderen.be/Borderel Borderel.xsd')
          .att('xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance')
          .att('xmlns:ns1', 'http://MFT-01-00.abb.vlaanderen.be/Borderel');
  xml.ele({
    'n1:RouteringsMetadata': {
      Entiteit:'ABB',
      Toepassing: 'BBC DR'
    }
  });
  const parameterSet = xml.ele('ParameterSet');
  parameterSet.ele(
    {
      ParameterParameterWaarde: {
        Parameter: 'SLEUTEL',
        ParameterWaarde: sleutel
      }
    }
  );
  parameterSet.ele(
    {
      ParameterParameterWaarde: {
        Parameter: 'FLOW',
        ParameterWaarde: 'AANLEVERING GEDAAN'
      }
    }
  );
  const bestandenElement = xml.root().ele('ns1:Bestanden');
  files.forEach( (file) => bestandenElement.ele({Bestand: {Bestandsnaam: file.filename}}));

  const output = xml.end({pretty: true});
  const filename = `${filePath}${report.id}-borderel.xml`;
  await fs.writeFile(filename, output, (err) => {
    if (err) throw err;
  });
  return filename;
};

/**
 * add package information to a bbcdr report
 * @method addPackage
 */
const addPackage = async function(report, packagePath) {
  await update(`
       PREFIX bbcdr: <http://mu.semte.ch/vocabularies/ext/bbcdr/>
       WITH <http://mu.semte.ch/application>
       INSERT DATA {
         ${sparqlEscapeUri(report)} bbcdr:package ${sparqlEscapeUri(packagePath)};
                                    bbcdr:packagedAt ${sparqlEscapeDateTime(new Date())}.
       }
  `);
};

/**
 * update the internal status of a report
 * @method updateInternalReportStatus
 */
const updateInternalReportStatus = async function(report, status) {
  await update(`
       PREFIX bbcdr: <http://mu.semte.ch/vocabularies/ext/bbcdr/>
       PREFIX dcterms: <http://purl.org/dc/terms/>
       WITH <http://mu.semte.ch/application>
       DELETE {
         ${sparqlEscapeUri(report)} dcterms:modified ?modified.
         ${sparqlEscapeUri(report)} bbcdr:status ?status.
       }
       INSERT {
         ${sparqlEscapeUri(report)} a bbcdr:Report;
                                    dcterms:modified ${sparqlEscapeDateTime(new Date())};
                                    bbcdr:status ${sparqlEscapeUri(status)}.
       }
       WHERE {
         {
           ${sparqlEscapeUri(report)} dcterms:modified ?modified.
         }
         UNION
         {
           OPTIONAL{ ${sparqlEscapeUri(report)} bbcdr:status ?status }
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
const fetchFilesForReport = async function(report) {
  const result = await query(`
       PREFIX mu:   <http://mu.semte.ch/vocabularies/core/>
       PREFIX nie:     <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>
       PREFIX nfo: <http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#>
       PREFIX dcterms: <http://purl.org/dc/terms/>
       PREFIX adms:    <http://www.w3.org/ns/adms#>
       PREFIX bbcdr: <http://mu.semte.ch/vocabularies/ext/bbcdr/>
       SELECT ?file ?filename ?format ?size
       FROM <http://mu.semte.ch/application>
       WHERE {
         ${sparqlEscapeUri(report)} a bbcdr:Report;
                                    nie:hasPart ?file.
         ?file nfo:fileName ?filename;
               dcterms:format ?format;
               nfo:fileSize ?size.
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
       PREFIX mu:   <http://mu.semte.ch/vocabularies/core/>
       PREFIX nie:     <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>
       PREFIX nfo: <http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#>
       PREFIX dcterms: <http://purl.org/dc/terms/>
       PREFIX adms:    <http://www.w3.org/ns/adms#>
       PREFIX bbcdr: <http://mu.semte.ch/vocabularies/ext/bbcdr/>
       SELECT ?report ?id
       FROM <http://mu.semte.ch/application>
       WHERE {
         ?report a bbcdr:Report;
                 adms:status <http://data.lblod.info/document-statuses/verstuurd>;
                 mu:uuid ?id;
                 dcterms:modified ?modified.
         FILTER NOT EXISTS {
            ?report bbcdr:status ?status.
         }
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
     WITH <http://mu.semte.ch/application>
     DELETE {
       ?report bbcdr:status ${sparqlEscapeUri(STATUS_PROCESSING)}.
     } WHERE {
       ?report a bbcdr:Report;
               bbcdr:status ${sparqlEscapeUri(STATUS_PROCESSING)}.
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
       GRAPH <http://mu.semte.ch/application> {
         ?report a bbcdr:Report;
         bbcdr:status ${sparqlEscapeUri(STATUS_PROCESSING)}.
       }
     }`);
  return queryResult.boolean;
}
export { isRunning, cleanup, addPackage, createZipFile, createMetadata, updateInternalReportStatus, fetchReportsToBePackaged, fetchFilesForReport, STATUS_PROCESSING, STATUS_PACKAGED };
