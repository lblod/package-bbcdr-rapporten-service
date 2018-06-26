import { CronJob } from 'cron';
import { app, uuid, errorHandler } from 'mu';
import {
  addPackage,
  createMetadata,
  createZipFile,
  cleanup,
  isRunning,
  updateInternalReportStatus,
  fetchReportsToBePackaged,
  fetchFilesForReport,
  STATUS_PROCESSING,
  STATUS_PACKAGED,
  STATUS_PACKAGING_FAILED  
} from './support';
import request from 'request';

/** Schedule export cron job */
const cronFrequency = process.env.PACKAGE_CRON_PATTERN || '* */12 * * * *';
const FILES_PER_REPORT = 2 ;

cleanup();

new CronJob(cronFrequency, function() {
  console.log(`BBCDR packaging triggered by cron job at ${new Date().toISOString()}`);
  request.post('http://localhost/package-bbcdr-reports/');
}, null, true);


app.post('/package-bbcdr-reports/', async function( req, res, next ) {
  try {
    if (await isRunning())
      return res.status(503).end();
    const reports = await fetchReportsToBePackaged();
    if (reports.length == 0) {
      console.log(`No BBCDR reports found that need to be packaged`);
      return res.status(204).end();
    }
    console.log(`Found ${reports.length} BBCDR reports to package`);
    Promise.all(reports.map( async (report) => { // don't await this since packaging is executed async
      console.log(`Start packaging BBCDR report ${report.id} found in graph <${report.graph}>`);
      try {
        await updateInternalReportStatus(report.uri, STATUS_PROCESSING, report.graph);
        const files = await fetchFilesForReport(report.uri, report.graph);
        if (files.length === FILES_PER_REPORT) {
          const borderel = await createMetadata(report, files, report.id);
          const zipUUID = uuid();
          const zipFile = await createZipFile(zipUUID, files, borderel);
          await addPackage(report.uri, zipFile, zipUUID, report.graph);
          await updateInternalReportStatus(report.uri, STATUS_PACKAGED, report.graph);
          console.log(`Packaged BBCDR report ${report.id} successfully`);
        } else {
          console.log(`Failed to package BBCDR report ${report.id}: only ${files.length} files are attached to the report while ${FILES_PER_REPORT} files are expected`);
          await updateInternalReportStatus(report.uri, STATUS_PACKAGING_FAILED, report.graph);
        }
      } catch(err) {
        console.log(`Failed to package BBCDR report ${report.id}: ${err}`);
        await updateInternalReportStatus(report.uri, STATUS_PACKAGING_FAILED, report.graph);
      }
    }));
    return res.status(202).send({status:202, title: 'processing'});    
  }
  catch(e) {
    return next(new Error(e.message));
  }
});

app.use(errorHandler);
