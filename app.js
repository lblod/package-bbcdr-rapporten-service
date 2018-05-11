import { CronJob } from 'cron';
import { app, uuid } from 'mu';
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
  console.log(`packaging triggered by cron job at ${new Date().toISOString()}`);
  request.post('http://localhost/package-bbcdr-reports/');
}, null, true);


app.post('/package-bbcdr-reports/', async function( req, res ) {
  try {
    if (await isRunning())
      return res.status(503).end();
    const reports = await fetchReportsToBePackaged();
    Promise.all(reports.map( async (report) => { // don't await this since packaging is executed async
      console.log(`Start packaging BBCDR report ${report.id}`);
      try {
        await updateInternalReportStatus(report.report, STATUS_PROCESSING);
        const files = await fetchFilesForReport(report.report);
        if (files.length === FILES_PER_REPORT) {
          const borderel = await createMetadata(report, files);
          const zipUUID = uuid();
          const zipFile = await createZipFile(zipUUID, files, borderel);
          await addPackage(report.report, zipFile, zipUUID);
          await updateInternalReportStatus(report.report, STATUS_PACKAGED);
          console.log(`Packaged BBCDR report ${report.id} successfully`);
        } else {
          console.log(`Failed to package BBCDR report ${report.id}: only ${files.length} files are attached to the report while ${FILES_PER_REPORT} files are expected`);
          await updateInternalReportStatus(report.report, STATUS_PACKAGING_FAILED);
        }
      } catch(err) {
        console.log(`Failed to package BBCDR report ${report.id}: ${err}`);
        await updateInternalReportStatus(report.report, STATUS_PACKAGING_FAILED);        
      }
    }));
    return res.status(202).send({status:202, title: 'processing'});    
  }
  catch(e) {
    console.log(e);
    throw e;
  }
});
